import path from 'node:path';
import { newSessionId } from '../credentials/oauth.js';
import { openAiToAntigravity } from '../rewrite/openai-translate.js';
import { dropIdleSockets, makeEgressAgent } from './egress.js';
import { accountLabel } from '../utils/alias.js';

export class UpstreamError extends Error {
  constructor(message, { status = 502, retryable = false, accountId = null, kind = 'other' } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.retryable = retryable;
    this.accountId = accountId;
    // rotation keys off this (quota -> cooldown + next account, auth -> invalidate + next account)
    this.kind = kind;
  }
}

/** Rejects once the signal aborts; the underlying work (a shared token refresh) keeps running. */
function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortFailure(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortFailure(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

/**
 * The reason a signal fired (client disconnect, request deadline, attempt cap, a flow stall), so the
 * caller can classify it instead of guessing from an error message. Falls back to a bare Error.
 */
export function abortFailure(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('aborted');
}

/**
 * An explicit upstream error object (an SSE `{"error":…}` frame, or a JSON body) as the same
 * structured UpstreamError the HTTP status path produces, so rotation keys off it identically.
 */
export function upstreamErrorFromJson(error, accountId = null) {
  const status = Number.isInteger(error?.code) ? error.code : 502;
  return upstreamErrorFrom(status, JSON.stringify({ error }), accountId);
}

export function upstreamErrorFrom(status, text, accountId) {
  // structured kind (M10): rotation keys off this, never off message text
  let kind = 'other';
  let parsedStatus = null;
  try {
    parsedStatus = JSON.parse(text)?.error?.status ?? null;
  } catch { /* not json */ }
  if (status === 429 || parsedStatus === 'RESOURCE_EXHAUSTED') kind = 'quota';
  else if (status === 401 || parsedStatus === 'UNAUTHENTICATED' || /invalid_grant/i.test(text)) kind = 'auth';
  return new UpstreamError(`upstream ${status}: ${text.slice(0, 400)}`, {
    status: status >= 500 ? 502 : status,
    accountId,
    kind,
  });
}

/**
 * Talks to the Cloud Code (antigravity) backend.
 * - one upstream client, account passed in per call
 * - access token refreshed in memory 5 min before expiry
 * - retryable: network errors and 5xx (NOT 429 — rotation handles that)
 * - egress: every account reaches Google through its own http(s) CONNECT proxy (node:https over the
 *   tunnel); the plain `fetch` branch only exists for a deployment with no egress configured
 */
export class UpstreamClient {
  constructor({ config, logger }) {
    this.config = config;
    this.logger = logger;
    // in-memory token cache: accountId -> { token, expiresAt }
    this.tokens = new Map();
    this.projects = new Map(); // accountId -> resolved project id
    this.agents = new Map(); // egressUrl -> agent
    this.refreshing = new Map(); // accountId -> in-flight refresh promise
  }

  agentFor(egressUrl) {
    if (!this.agents.has(egressUrl)) {
      this.agents.set(egressUrl, makeEgressAgent({ egressUrl }));
    }
    return this.agents.get(egressUrl);
  }

  /**
   * The account's own exit: upstream.egress.accounts maps an account (email, else the credential
   * file name) to its egress url, so each account reaches Google from its own IP. Unmapped
   * accounts use upstream.egress.url.
   */
  egressFor(account) {
    const egress = this.config.upstream.egress ?? {};
    const perAccount = egress.accounts ?? {};
    const byEmail = account?.email ? perAccount[account.email] : undefined;
    const byFile = account?.id ? perAccount[path.basename(account.id)] : undefined;
    return byEmail ?? byFile ?? egress.url ?? null;
  }

  /** fetch-shaped call through the account's egress (the oauth refresh must not leave from the host IP). */
  #fetchVia(egressUrl) {
    if (!egressUrl) return globalThis.fetch;
    return (url, { method = 'GET', headers = {}, body, signal } = {}) =>
      this.request(url, { method, headers, body: body == null ? undefined : String(body), signal, egressUrl });
  }

  /**
   * The token refresh is shared by every caller of one account and is never cancelled by a caller
   * that leaves, so its own network needs its own bound: without this a hung token endpoint pins
   * the shared promise (and its dedup entry) forever.
   */
  #boundedFetch(fetchImpl, timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || typeof AbortSignal?.timeout !== 'function') return fetchImpl;
    return (url, options = {}) => fetchImpl(url, { ...options, signal: options.signal ?? AbortSignal.timeout(timeoutMs) });
  }

  /**
   * Raw request honoring egress: returns a fetch-like Response (body is a stream).
   * node:https over the CONNECT tunnel, not global fetch: the tunnel is what production uses, and
   * fetch gives no handle to destroy a body that stalled after the headers.
   */
  async request(url, { method = 'POST', headers = {}, body, signal, egressUrl: accountEgress }) {
    // an abort listener added after the fact never fires: refuse to start an already aborted request
    if (signal?.aborted) throw abortFailure(signal);
    const egressUrl = accountEgress !== undefined ? accountEgress : (this.config.upstream.egress?.url ?? null);
    if (!egressUrl) {
      return globalThis.fetch(url, { method, headers, body, signal });
    }
    // node:https path (egress configured)
    const { default: https_ } = await import('node:https');
    // the dynamic import yields the event loop: the caller may have hung up while it was pending
    if (signal?.aborted) throw abortFailure(signal);
    const target = new URL(url);
    const payload = body ?? null;
    return new Promise((resolve, reject) => {
      let settled = false;
      let request = null;
      let response = null;
      const detach = () => signal?.removeEventListener('abort', onAbort);
      // Before the headers this kills the request; after them it destroys the response body too, so
      // a stalled stream cannot hold the tunnel open for a caller that is already gone.
      const onAbort = () => {
        try { request?.destroy(); } catch { /* already gone */ }
        try { response?.destroy(); } catch { /* already gone */ }
        if (settled) return;
        settled = true;
        detach();
        reject(abortFailure(signal));
      };
      /** Reads the whole body; a body cut by the peer keeps what arrived, an abort rejects. */
      const readText = () => new Promise((resolveText, rejectText) => {
        if (signal?.aborted) { rejectText(abortFailure(signal)); return; }
        const chunks = [];
        let done = false;
        const onData = (chunk) => chunks.push(chunk);
        const finish = (fn, value) => {
          if (done) return;
          done = true;
          signal?.removeEventListener('abort', onReadAbort);
          response?.off('data', onData);
          response?.off('end', onEnd);
          response?.off('error', onReadError);
          fn(value);
        };
        const onEnd = () => finish(resolveText, Buffer.concat(chunks).toString('utf8'));
        // a body cut by the peer keeps what arrived: the status still classifies the failure
        const onReadError = () => finish(resolveText, Buffer.concat(chunks).toString('utf8'));
        const onReadAbort = () => finish(rejectText, abortFailure(signal));
        response.on('data', onData);
        response.on('end', onEnd);
        response.on('error', onReadError);
        signal?.addEventListener('abort', onReadAbort, { once: true });
      });
      request = https_.request({
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method,
        headers: {
          ...(payload !== null ? { 'content-length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
        agent: this.agentFor(egressUrl),
      }, (res) => {
        response = res;
        const status = res.statusCode;
        const ok = { ok: status >= 200 && status < 300, status, headers: res.headers };
        const buffered = status >= 300 || method !== 'POST' || headers.accept !== 'text/event-stream';
        if (buffered) {
          // buffer non-stream bodies fully (error paths, non-stream chat)
          readText().then(
            (text) => {
              if (settled) return;
              settled = true;
              detach();
              resolve({ ...ok, text: async () => text, json: async () => JSON.parse(text), body: null, signal });
            },
            (error) => {
              if (settled) return;
              settled = true;
              detach();
              reject(error);
            },
          );
          return;
        }
        if (settled) return;
        settled = true;
        // The body is the caller's now, so the abort listener lives exactly as long as the response:
        // a normal completion and a destroyed body both close it, and neither leaves it behind.
        res.once('close', detach);
        resolve({ ...ok, text: readText, json: async () => JSON.parse(await readText()), body: res, signal });
      });
      request.on('error', (error) => {
        if (settled) return;
        settled = true;
        detach();
        reject(error);
      });
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      if (payload !== null) request.write(payload);
      request.end();
    });
  }

  async accessToken(account, { fetchImpl = this.#fetchVia(this.egressFor(account)) } = {}) {
    const cached = this.tokens.get(account.id);
    const eager = this.config.upstream.eagerRefreshMs;
    if (cached && cached.expiresAt - Date.now() > eager) {
      return cached.token;
    }
    // in-flight dedup: N concurrent requests -> one refresh call
    let pending = this.refreshing.get(account.id);
    if (!pending) {
      pending = (async () => {
        const { refreshAccessToken } = await import('../credentials/oauth.js');
        try {
          const { accessToken, expiresIn } = await refreshAccessToken(account.refreshToken, {
            fetchImpl: this.#boundedFetch(fetchImpl, this.config.upstream.requestTimeoutMs),
          });
          this.tokens.set(account.id, { token: accessToken, expiresAt: Date.now() + expiresIn * 1000 });
          this.logger.info('oauth.refreshed', { account: accountLabel(account), expiresIn });
          return accessToken;
        } catch (error) {
          // auth-dead refresh -> structured kind so rotation fires
          throw new UpstreamError(`oauth refresh failed: ${error.message}`, { status: 401, kind: 'auth', accountId: account.id });
        }
      })().finally(() => this.refreshing.delete(account.id));
      this.refreshing.set(account.id, pending);
    }
    return pending;
  }

  invalidate(accountId) {
    this.tokens.delete(accountId);
    this.projects.delete(accountId);
  }

  /**
   * Project id for the account. Sources: credential file field, then a one-time
   * loadCodeAssist probe (ideType ANTIGRAVITY) — same flow as the CLIProxyAPI
   * antigravity auth (auth.go FetchProjectID). Cached in memory per account.
   * The caller's signal is checked before the probe and handed to its request and body read: a
   * cancelled call must not start a network round trip, not even after the shared token refresh it
   * was waiting for finally finished.
   */
  async ensureProject(account, { fetchImpl, signal } = {}) {
    if (account.projectId) return account.projectId;
    if (this.projects.has(account.id)) return this.projects.get(account.id);
    if (signal?.aborted) throw abortFailure(signal);
    const token = await abortable(this.accessToken(account, fetchImpl ? { fetchImpl } : {}), signal);
    if (signal?.aborted) throw abortFailure(signal);
    const url = `${this.config.upstream.baseUrl}/${this.config.upstream.apiVersion}:loadCodeAssist`;
    const body = JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } });
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': this.config.upstream.userAgent,
    };
    const response = await this.request(url, { method: 'POST', headers, body, signal, egressUrl: this.egressFor(account) });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      if (signal?.aborted) throw abortFailure(signal);
      throw new UpstreamError(`loadCodeAssist ${response.status}: ${text.slice(0, 200)}`, { status: response.status >= 500 ? 502 : response.status, retryable: false, accountId: account.id });
    }
    let json;
    try {
      json = await response.json();
    } catch (error) {
      if (signal?.aborted) throw abortFailure(signal);
      json = JSON.parse(await response.text());
    }
    if (signal?.aborted) throw abortFailure(signal);
    const project = json?.cloudaicompanionProject ?? json?.projectId ?? json?.project ?? null;
    if (!project) {
      throw new UpstreamError('loadCodeAssist: no cloudaicompanionProject in response', { status: 502, accountId: account.id });
    }
    account.projectId = project;
    this.projects.set(account.id, project);
    // the project id itself stays out of the journal
    this.logger.info('project.resolved', { account: accountLabel(account) });
    return project;
  }

  async buildBody(openAiBody, account, { signal } = {}) {
    const projectId = await this.ensureProject(account, { signal });
    if (signal?.aborted) throw abortFailure(signal);
    const { canonicalModel } = await import('../rewrite/openai-translate.js');
    return openAiToAntigravity({ ...openAiBody, model: canonicalModel(openAiBody.model) }, {
      projectId,
      sessionId: newSessionId(),
    });
  }

  /**
   * Non-streaming generate. Returns parsed JSON of the antigravity response.
   */
  async generate({ openAiBody, account, fetchImpl, signal }) {
    return this.#prepareAndFetch({ openAiBody, account, fetchImpl, signal, stream: false });
  }

  /**
   * Streaming generate. Returns the raw upstream Response (SSE body) — the caller
   * pipes frames. Uses streamGenerateContent?alt=sse.
   */
  async generateStream({ openAiBody, account, fetchImpl, signal }) {
    return this.#prepareAndFetch({ openAiBody, account, fetchImpl, signal, stream: true });
  }

  /** Token, project and body, each abortable: a caller that left starts no further step. */
  async #prepareAndFetch({ openAiBody, account, fetchImpl, signal, stream }) {
    if (signal?.aborted) throw abortFailure(signal);
    const token = await abortable(this.accessToken(account, fetchImpl ? { fetchImpl } : {}), signal);
    if (signal?.aborted) throw abortFailure(signal);
    const body = await abortable(this.buildBody(openAiBody, account, { signal }), signal);
    if (signal?.aborted) throw abortFailure(signal);
    const url = `${this.config.upstream.baseUrl}/${this.config.upstream.apiVersion}:`
      + (stream ? 'streamGenerateContent?alt=sse' : 'generateContent');
    return this.#doFetch({ url, token, body, account, fetchImpl, signal, stream });
  }

  async #doFetch({ url, token, body, account, fetchImpl, signal, stream }) {
    // a request cancelled before it started (client gone, deadline spent) never reaches the wire
    if (signal?.aborted) throw abortFailure(signal);
    // enforce requestTimeoutMs (C2), combined with any client signal
    let combined = signal ?? null;
    if (typeof AbortSignal?.timeout === 'function') {
      const timeoutSignal = AbortSignal.timeout(this.config.upstream.requestTimeoutMs);
      combined = combined ? AbortSignal.any([combined, timeoutSignal]) : timeoutSignal;
    }
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': this.config.upstream.userAgent,
      ...(stream ? { accept: 'text/event-stream' } : {}),
    };
    const payload = JSON.stringify(body);
    const egressUrl = this.egressFor(account);

    // One retry, pre-flight failures only (H1): if any response bytes arrived,
    // the request reached the backend and a blind re-POST could double-bill.
    let preflightFailure = null;
    try {
      const response = await this.request(url, { method: 'POST', headers, body: payload, signal: combined, egressUrl });
      if (response.ok) return response;
      const text = await response.text().catch(() => '');
      throw upstreamErrorFrom(response.status, text, account.id);
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      if (signal?.aborted) throw abortFailure(signal);
      if (error.name === 'AbortError' || /aborted|timed? ?out/i.test(error.message)) {
        // timeout or client abort: do not retry
        throw new UpstreamError(`upstream timeout/abort: ${error.message}`, { status: 504, accountId: account.id, kind: 'other' });
      }
      preflightFailure = error;
    }
    // the caller may have hung up while the first attempt was failing: do not re-POST for nobody
    if (signal?.aborted) throw abortFailure(signal);
    // single pre-flight retry, on a fresh connection: the failed attempt most likely took a dead
    // pooled socket, and the pool can hold more of them (23.09 03:43: the retry hit one too)
    for (const agent of this.agents.values()) dropIdleSockets(agent);
    try {
      const response = await this.request(url, { method: 'POST', headers, body: payload, signal: combined, egressUrl });
      if (response.ok) return response;
      const text = await response.text().catch(() => '');
      throw upstreamErrorFrom(response.status, text, account.id);
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      if (signal?.aborted) throw abortFailure(signal);
      throw new UpstreamError(`network error: ${preflightFailure?.message ?? error.message}`, { status: 502, accountId: account.id, kind: 'other' });
    }
  }
}
