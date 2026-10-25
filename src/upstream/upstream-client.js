import path from 'node:path';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { newSessionId } from '../credentials/oauth.js';
import { materialGeneration } from '../credentials/credential-store.js';
import { canonicalModel, openAiToAntigravity } from '../rewrite/openai-translate.js';
import { errorCategory } from '../utils/error-category.js';
import { dropIdleSockets, makeEgressAgent } from './egress.js';
import { accountLabel } from '../utils/alias.js';
import {
  UpstreamError,
  publicFailureText,
  upstreamErrorFrom,
  upstreamErrorFromJson,
} from './failure.js';

// The structured failure contract lives in failure.js; these re-exports keep the historical
// import sites (`upstream-client.js`) working.
export { UpstreamError, upstreamErrorFrom, upstreamErrorFromJson };

/** Private material generation of an account: access-token refreshes keep it, re-login changes it. */
export function generationOf(account) {
  if (!account) return null;
  if (typeof account.generation === 'string' && account.generation !== '') return account.generation;
  return materialGeneration(account.refreshToken);
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

function oauthFailure(error, account, generation) {
  const reason = ['revoked_credential', 'oauth_unavailable', 'oauth_malformed', 'oauth_rejected'].includes(error?.reason)
    ? error.reason
    : (error?.transient === true ? 'oauth_unavailable' : 'oauth_rejected');
  const scope = reason === 'revoked_credential' ? 'credential' : 'unknown';
  return new UpstreamError(publicFailureText(reason), {
    origin: 'oauth',
    phase: 'refresh',
    reason,
    scope,
    evidence: error?.evidence ?? 'oauth_http_status',
    observedStatus: error?.observedStatus ?? null,
    publicStatus: 502,
    retryable: error?.transient === true,
    accountId: account.id,
    generation,
    cause: error,
  });
}

function egressFailure(error, meta) {
  const reason = ['egress_invalid_config', 'egress_unavailable', 'egress_refused'].includes(error?.reason)
    ? error.reason
    : 'egress_unavailable';
  return new UpstreamError(publicFailureText(reason), {
    origin: 'egress',
    phase: 'connect',
    reason,
    scope: 'egress',
    evidence: error?.evidence ?? 'egress_dial',
    publicStatus: 502,
    retryable: true,
    accountId: meta.accountId,
    generation: meta.generation,
    egressKey: meta.egressKey,
    egressAlias: meta.egressAlias,
    cause: error,
  });
}

function networkFailure(error, meta, phase = 'dispatch') {
  const category = errorCategory(error);
  return new UpstreamError('upstream network failure', {
    origin: 'generation',
    phase,
    reason: 'unknown',
    scope: 'unknown',
    evidence: category === 'error' ? 'unclassified_error' : `error_${category}`,
    publicStatus: 502,
    retryable: true,
    accountId: meta.accountId,
    generation: meta.generation,
    egressKey: meta.egressKey,
    egressAlias: meta.egressAlias,
    cause: error,
  });
}

function timeoutFailure(meta) {
  return new UpstreamError('upstream request timed out', {
    origin: 'generation',
    phase: 'dispatch',
    reason: 'timeout',
    scope: 'request',
    evidence: 'local_abort',
    publicStatus: 504,
    retryable: true,
    accountId: meta.accountId,
    generation: meta.generation,
    egressKey: meta.egressKey,
    egressAlias: meta.egressAlias,
  });
}

function isTimeoutCode(code) {
  return code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ERR_SOCKET_CONNECTION_TIMEOUT';
}

/**
 * Talks to the Cloud Code (antigravity) backend.
 * - one upstream client, account passed in per call
 * - access token refreshed in memory 5 min before expiry, keyed by credential MATERIAL generation
 * - the connection retry and the forced-auth retry share one two-POST allowance per credential
 * - egress: every account reaches Google through its own http(s) CONNECT proxy; a proven egress
 *   dial/CONNECT failure is attributed to that egress and never falls back to a direct connection
 */
export class UpstreamClient {
  constructor({ config, logger, currentGeneration }) {
    this.config = config;
    this.logger = logger;
    this.currentGeneration = currentGeneration;
    // in-memory token cache: accountId -> { token, expiresAt, generation, version }
    this.tokens = new Map();
    // accountId -> { projectId, generation }
    this.projects = new Map();
    // egressUrl -> agent
    this.agents = new Map();
    // "<accountId>\0<generation>" -> in-flight refresh promise
    this.refreshing = new Map();
    this.tokenVersion = 0;
    this.projectVersion = 0;
  }

  #assertCurrent(account, phase) {
    let current;
    try { current = this.currentGeneration(account); } catch { current = null; }
    if (typeof current !== 'string' || current === '') {
      throw new UpstreamError('credential ownership unavailable', {
        origin: 'local', phase, reason: 'invalid_local_config', scope: 'request',
        evidence: 'credential_generation', publicStatus: 503,
      });
    }
    if (current !== generationOf(account)) {
      throw new UpstreamError('credential replaced during preparation', {
        origin: 'local', phase, reason: 'credential_replaced', scope: 'credential',
        evidence: 'credential_generation', publicStatus: 503,
        accountId: account.id, generation: generationOf(account),
      });
    }
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

  /**
   * Effective egress identity. Two authenticated proxy sessions can share host:port, so the private
   * key is the whole configured URL (including credentials). Only `alias` may be journaled.
   */
  egressIdentityFor(account) {
    const url = this.egressFor(account);
    if (!url) return { key: null, alias: 'direct' };
    return {
      key: url,
      alias: `egress-${createHash('sha256').update(url).digest('hex').slice(0, 8)}`,
    };
  }

  /** fetch-shaped call through the account's egress (the oauth refresh must not leave from the host IP). */
  #fetchVia(egressUrl) {
    if (!egressUrl) return globalThis.fetch;
    return (url, { method = 'GET', headers = {}, body, signal } = {}) =>
      this.request(url, { method, headers, body: body == null ? undefined : String(body), signal, egressUrl });
  }

  /**
   * The token refresh is shared by every caller of one account/generation and is never cancelled by
   * a caller that leaves, so its own network needs its own bound.
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
      request = https.request({
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

  #refreshKey(account, generation) {
    return `${account.id}\u0000${generation ?? 'unknown'}`;
  }

  async accessToken(account, { fetchImpl = this.#fetchVia(this.egressFor(account)), budget = null } = {}) {
    this.#assertCurrent(account, 'refresh');
    const generation = generationOf(account);
    const cached = this.tokens.get(account.id);
    const eager = this.config.upstream.eagerRefreshMs;
    if (cached && cached.generation === generation && cached.expiresAt - Date.now() > eager) {
      return cached.token;
    }
    const key = this.#refreshKey(account, generation);
    // in-flight dedup: N concurrent requests -> one refresh call; a join is not a physical POST
    let pending = this.refreshing.get(key);
    if (pending) {
      budget?.recordJoin();
      return pending;
    }
    if (budget && !budget.takeOAuth(account.id)) {
      throw new UpstreamError('oauth dispatch budget exhausted', {
        origin: 'oauth', phase: 'refresh', reason: 'budget_exhausted', scope: 'request',
        evidence: 'dispatch_budget', publicStatus: 503, accountId: account.id, generation,
      });
    }
    const refreshVersion = ++this.tokenVersion;
    const promise = (async () => {
      const { refreshAccessToken } = await import('../credentials/oauth.js');
      try {
        this.#assertCurrent(account, 'refresh');
        const { accessToken, expiresIn } = await refreshAccessToken(account.refreshToken, {
          fetchImpl: this.#boundedFetch(fetchImpl, this.config.upstream.requestTimeoutMs),
        });
        this.#assertCurrent(account, 'refresh');
        // A material replacement while the refresh was in flight must not cache the old token.
        if (generationOf(account) !== generation) {
          throw new UpstreamError('credential replaced during refresh', {
            origin: 'oauth', phase: 'refresh', reason: 'credential_replaced', scope: 'credential',
            evidence: 'credential_generation', publicStatus: 502, accountId: account.id, generation,
          });
        }
        const current = this.tokens.get(account.id);
        // A late old-generation result must not replace a token written by newer material.
        if (current && current.generation !== generation && current.version > refreshVersion) {
          this.logger.info('oauth.stale_result_discarded', {
            account: accountLabel(account), tokenVersion: refreshVersion,
          });
          return accessToken;
        }
        this.tokens.set(account.id, {
          token: accessToken,
          expiresAt: Date.now() + expiresIn * 1000,
          generation,
          version: refreshVersion,
        });
        this.logger.info('oauth.refreshed', { account: accountLabel(account), expiresIn, tokenVersion: refreshVersion });
        return accessToken;
      } catch (error) {
        if (error instanceof UpstreamError) throw error;
        const egressError = error?.name === 'EgressError' ? error : error?.cause;
        if (egressError?.name === 'EgressError') {
          const egress = this.egressIdentityFor(account);
          throw egressFailure(egressError, { accountId: account.id, generation, egressKey: egress.key, egressAlias: egress.alias });
        }
        throw oauthFailure(error, account, generation);
      }
    })();
    this.refreshing.set(key, promise);
    // Cleanup is ownership-checked: a stale finally must not delete a newer generation's entry.
    promise.then(
      () => { if (this.refreshing.get(key) === promise) this.refreshing.delete(key); },
      () => { if (this.refreshing.get(key) === promise) this.refreshing.delete(key); },
    );
    return promise;
  }

  /** Drops a cached access token so the next attempt refreshes; generation-checked. */
  forceRefresh(account) {
    const generation = generationOf(account);
    const cached = this.tokens.get(account.id);
    if (!cached) return false;
    if (generation == null || cached.generation === generation) {
      this.tokens.delete(account.id);
      return true;
    }
    return false;
  }

  /**
   * Generation-checked cache invalidation. Without a known material generation this is a no-op:
   * deleting "whatever is cached" could erase a newer credential's token after a late old failure.
   */
  invalidate(account, { generation = null } = {}) {
    const id = typeof account === 'string' ? account : account?.id;
    const expected = generation ?? (typeof account === 'object' ? generationOf(account) : null);
    if (expected == null) return false;
    let deleted = false;
    const cached = this.tokens.get(id);
    if (cached && cached.generation === expected) { this.tokens.delete(id); deleted = true; }
    const project = this.projects.get(id);
    if (project && project.generation === expected) { this.projects.delete(id); deleted = true; }
    return deleted;
  }

  /**
   * Project id for the account. Sources: credential file field, then a one-time loadCodeAssist
   * probe (ideType ANTIGRAVITY). Cached per account AND material generation: a replaced credential
   * never reuses the old project. The caller's signal is checked before the probe and handed to
   * its request and body read.
   */
  async ensureProject(account, { signal, budget = null } = {}) {
    this.#assertCurrent(account, 'project_resolution');
    const generation = generationOf(account);
    if (account.projectId) return account.projectId;
    const cached = this.projects.get(account.id);
    if (cached && cached.generation === generation) return cached.projectId;
    if (signal?.aborted) throw abortFailure(signal);
    const token = await abortable(this.accessToken(account, { budget }), signal);
    if (signal?.aborted) throw abortFailure(signal);
    if (budget && !budget.takeProject(account.id)) {
      throw new UpstreamError('project dispatch budget exhausted', {
        origin: 'project', phase: 'project_resolution', reason: 'budget_exhausted', scope: 'request',
        evidence: 'dispatch_budget', publicStatus: 503, accountId: account.id, generation,
      });
    }
    const projectVersion = ++this.projectVersion;
    this.#assertCurrent(account, 'project_resolution');
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
      const error = upstreamErrorFrom(response.status, text, account.id, response.headers, { generation });
      error.origin = 'project';
      error.phase = 'project_resolution';
      throw error;
    }
    let json;
    try {
      json = await response.json();
    } catch (error) {
      if (signal?.aborted) throw abortFailure(signal);
      throw new UpstreamError('loadCodeAssist response was malformed', {
        origin: 'project', phase: 'project_resolution', reason: 'malformed', scope: 'request',
        evidence: 'json_body_parse', publicStatus: 502, accountId: account.id, generation, cause: error,
      });
    }
    if (signal?.aborted) throw abortFailure(signal);
    this.#assertCurrent(account, 'project_resolution');
    const project = json?.cloudaicompanionProject ?? json?.projectId ?? json?.project ?? null;
    if (!project || typeof project !== 'string') {
      throw new UpstreamError('loadCodeAssist returned no project', {
        origin: 'project', phase: 'project_resolution', reason: 'malformed', scope: 'request',
        evidence: 'project_response', publicStatus: 502, accountId: account.id, generation,
      });
    }
    const current = this.projects.get(account.id);
    if (generationOf(account) === generation && !(current && current.version > projectVersion)) {
      account.projectId = project;
      this.projects.set(account.id, { projectId: project, generation, version: projectVersion });
    }
    // the project id itself stays out of the journal
    this.logger.info('project.resolved', { account: accountLabel(account) });
    return project;
  }

  async buildBody(openAiBody, account, { signal, projectId } = {}) {
    const resolved = projectId ?? await this.ensureProject(account, { signal });
    if (signal?.aborted) throw abortFailure(signal);
    return openAiToAntigravity(
      { ...openAiBody, model: canonicalModel(openAiBody.model) },
      { projectId: resolved, sessionId: newSessionId() },
    );
  }

  async generate({ openAiBody, account, fetchImpl, signal, budget = null, beforeDispatch = null, requestId = null }) {
    return this.#prepareAndFetch({ openAiBody, account, fetchImpl, signal, stream: false, budget, beforeDispatch, requestId });
  }

  async generateStream({ openAiBody, account, fetchImpl, signal, budget = null, beforeDispatch = null, requestId = null }) {
    return this.#prepareAndFetch({ openAiBody, account, fetchImpl, signal, stream: true, budget, beforeDispatch, requestId });
  }

  /** Token, project and body, each abortable: a caller that left starts no further step. */
  async #prepareAndFetch({ openAiBody, account, fetchImpl, signal, stream, budget, beforeDispatch, requestId }) {
    if (signal?.aborted) throw abortFailure(signal);
    const generation = generationOf(account);
    const token = await abortable(this.accessToken(account, fetchImpl ? { fetchImpl, budget } : { budget }), signal);
    if (signal?.aborted) throw abortFailure(signal);
    const projectId = await abortable(this.ensureProject(account, { signal, budget }), signal);
    if (signal?.aborted) throw abortFailure(signal);
    const body = await abortable(this.buildBody(openAiBody, account, { signal, projectId }), signal);
    if (signal?.aborted) throw abortFailure(signal);
    const egress = this.egressIdentityFor(account);
    const meta = {
      requestId,
      accountId: account.id,
      generation,
      projectId,
      outboundModel: body?.model ?? null,
      requestedModel: openAiBody?.model ?? null,
      egressKey: egress.key,
      egressAlias: egress.alias,
    };
    const url = `${this.config.upstream.baseUrl}/${this.config.upstream.apiVersion}:`
      + (stream ? 'streamGenerateContent?alt=sse' : 'generateContent');
    return this.#doFetch({
      url, token, body, account, fetchImpl, signal, stream, budget, beforeDispatch, meta,
    });
  }

  async #doFetch({ url, token, body, account, fetchImpl, signal, stream, budget, beforeDispatch, meta }) {
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
      ...(meta?.requestId ? { 'x-request-id': meta.requestId } : {}),
      ...(stream ? { accept: 'text/event-stream' } : {}),
    };
    const payload = JSON.stringify(body);
    const egressUrl = this.egressFor(account);

    const classifyThrown = (error) => {
      if (error instanceof UpstreamError) return error;
      if (signal?.aborted) return abortFailure(signal);
      if (error?.name === 'EgressError') return egressFailure(error, meta);
      if (combined?.aborted) return timeoutFailure(meta);
      if (error?.name === 'AbortError' || isTimeoutCode(error?.code)) return timeoutFailure(meta);
      return networkFailure(error, meta);
    };

    const dispatch = async () => {
      // Immediately before the wire: the caller may be gone, the credential may have been replaced,
      // a resolved resource gate may now apply, or this recovery probe may have lost its lease.
      if (signal?.aborted) throw abortFailure(signal);
      if (beforeDispatch) {
        const check = beforeDispatch(meta);
        if (check?.then) await check;
      }
      if (signal?.aborted) throw abortFailure(signal);
      if (budget && !budget.takeGeneration(account.id)) {
        throw new UpstreamError('generation dispatch budget exhausted', {
          origin: 'generation', phase: 'dispatch', reason: 'budget_exhausted', scope: 'request',
          evidence: 'dispatch_budget', publicStatus: 503, accountId: account.id, generation: meta.generation,
        });
      }
      return this.request(url, { method: 'POST', headers, body: payload, signal: combined, egressUrl });
    };

    // A transport failure may have reached the provider: its one retry is another metered POST.
    // Observed HTTP responses and policy/budget stops never enter this connection retry.
    const CONNECTION_RETRYABLE = new Set(['timeout', 'egress_unavailable', 'egress_refused', 'unknown']);
    let transportFailure = null;
    try {
      const response = await dispatch();
      if (response.ok) return response;
      const text = await response.text().catch(() => '');
      throw upstreamErrorFrom(response.status, text, account.id, response.headers, { generation: meta.generation });
    } catch (error) {
      if (error instanceof UpstreamError) {
        if (error.observedStatus !== null || !CONNECTION_RETRYABLE.has(error.reason)) throw error;
        transportFailure = error;
      } else {
        if (signal?.aborted) throw abortFailure(signal);
        const classified = classifyThrown(error);
        if (!(classified instanceof UpstreamError)) throw classified;
        if (!CONNECTION_RETRYABLE.has(classified.reason)) throw classified;
        transportFailure = classified;
      }
    }
    // the caller may have hung up while the first attempt was failing: do not re-POST for nobody
    if (signal?.aborted) throw abortFailure(signal);
    if (budget && !budget.canTakeGeneration(account.id)) throw transportFailure;
    // single transport retry, on a fresh connection: the failed attempt most likely took a dead
    // pooled socket, and the pool can hold more of them (23.09 03:43: the retry hit one too)
    for (const agent of this.agents.values()) dropIdleSockets(agent);
    try {
      const response = await dispatch();
      if (response.ok) return response;
      const text = await response.text().catch(() => '');
      throw upstreamErrorFrom(response.status, text, account.id, response.headers, { generation: meta.generation });
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      if (signal?.aborted) throw abortFailure(signal);
      const classified = classifyThrown(error);
      if (classified instanceof UpstreamError) throw classified;
      throw networkFailure(error, meta, 'connect');
    }
  }
}
