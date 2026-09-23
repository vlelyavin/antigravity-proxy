import { newSessionId } from '../credentials/oauth.js';
import { openAiToAntigravity } from '../rewrite/openai-translate.js';
import { dropIdleSockets, makeEgressAgent } from './egress.js';

export class UpstreamError extends Error {
  constructor(message, { status = 502, retryable = false, accountId = null } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.retryable = retryable;
    this.accountId = accountId;
  }
}

/**
 * Talks to the Cloud Code (antigravity) backend.
 * - one upstream client, account passed in per call
 * - access token refreshed in memory 5 min before expiry
 * - retryable: network errors and 5xx (NOT 429 — rotation handles that)
 * - egress: when config.upstream.egress.url is set, requests go through a
 *   socks5/http CONNECT agent instead of global fetch
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

  /** Raw request honoring egress: returns a fetch-like Response (body is a stream). */
  async request(url, { method = 'POST', headers = {}, body, signal }) {
    const egressUrl = this.config.upstream.egress?.url ?? null;
    if (!egressUrl) {
      return globalThis.fetch(url, { method, headers, body, signal });
    }
    // node:http path (egress configured)
    const { default: https_ } = await import('node:https');
    const target = new URL(url);
    const payload = body ?? null;
    return new Promise((resolve, reject) => {
      const req = https_.request({
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
        const chunks = [];
        const status = res.statusCode;
        const responseHeaders = res.headers;
        const text = () => new Promise((r) => {
          if (chunks.length > 0 && chunks.done) return r(chunks.text);
          let out = '';
          res.on('data', (c) => { out += c; });
          res.on('end', () => { chunks.text = out; chunks.done = true; r(out); });
          res.on('error', () => r(chunks.text ?? out));
        });
        const ok = { ok: status >= 200 && status < 300, status, headers: responseHeaders };
        if (status >= 300 || method !== 'POST' || headers.accept !== 'text/event-stream') {
          // buffer non-stream bodies fully (error paths, non-stream chat)
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({
            ...ok,
            text: async () => Buffer.concat(chunks).toString('utf8'),
            json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
            body: null,
            signal: null,
          }));
          res.on('error', reject);
        } else {
          // streaming: expose the response stream as body
          resolve({
            ...ok,
            text,
            json: async () => JSON.parse(await text()),
            body: res,
            signal: null,
          });
        }
      });
      req.on('error', reject);
      if (payload !== null) req.write(payload);
      req.end();
      if (signal) {
        signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
      }
    });
  }

  async accessToken(account, { fetchImpl = globalThis.fetch } = {}) {
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
          const { accessToken, expiresIn } = await refreshAccessToken(account.refreshToken, { fetchImpl });
          this.tokens.set(account.id, { token: accessToken, expiresAt: Date.now() + expiresIn * 1000 });
          this.logger.info('oauth.refreshed', { account: account.email || account.id, expiresIn });
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
   */
  async ensureProject(account, { fetchImpl = globalThis.fetch } = {}) {
    if (account.projectId) return account.projectId;
    if (this.projects.has(account.id)) return this.projects.get(account.id);
    const token = await this.accessToken(account, { fetchImpl });
    const url = `${this.config.upstream.baseUrl}/${this.config.upstream.apiVersion}:loadCodeAssist`;
    const body = JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } });
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': this.config.upstream.userAgent,
    };
    const response = await this.request(url, { method: 'POST', headers, body });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new UpstreamError(`loadCodeAssist ${response.status}: ${text.slice(0, 200)}`, { status: response.status >= 500 ? 502 : response.status, retryable: false, accountId: account.id });
    }
    const json = await response.json().catch(async () => JSON.parse(await response.text()));
    const project = json?.cloudaicompanionProject ?? json?.projectId ?? json?.project ?? null;
    if (!project) {
      throw new UpstreamError('loadCodeAssist: no cloudaicompanionProject in response', { status: 502, accountId: account.id });
    }
    account.projectId = project;
    this.projects.set(account.id, project);
    this.logger.info('project.resolved', { account: account.email || account.id, project });
    return project;
  }

  async buildBody(openAiBody, account) {
    const projectId = await this.ensureProject(account);
    const { canonicalModel } = await import('../rewrite/openai-translate.js');
    return openAiToAntigravity({ ...openAiBody, model: canonicalModel(openAiBody.model) }, {
      projectId,
      sessionId: newSessionId(),
    });
  }

  /**
   * Non-streaming generate. Returns parsed JSON of the antigravity response.
   */
  async generate({ openAiBody, account, fetchImpl = globalThis.fetch, signal }) {
    const token = await this.accessToken(account, { fetchImpl });
    const body = await this.buildBody(openAiBody, account);
    const url = `${this.config.upstream.baseUrl}/${this.config.upstream.apiVersion}:generateContent`;
    return this.#doFetch({ url, token, body, account, fetchImpl, signal, stream: false });
  }

  /**
   * Streaming generate. Returns the raw upstream Response (SSE body) — the caller
   * pipes frames. Uses streamGenerateContent?alt=sse.
   */
  async generateStream({ openAiBody, account, fetchImpl = globalThis.fetch, signal }) {
    const token = await this.accessToken(account, { fetchImpl });
    const body = await this.buildBody(openAiBody, account);
    const url = `${this.config.upstream.baseUrl}/${this.config.upstream.apiVersion}:streamGenerateContent?alt=sse`;
    return this.#doFetch({ url, token, body, account, fetchImpl, signal, stream: true });
  }

  async #doFetch({ url, token, body, account, fetchImpl, signal, stream }) {
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

    // One retry, pre-flight failures only (H1): if any response bytes arrived,
    // the request reached the backend and a blind re-POST could double-bill.
    let preflightFailure = null;
    try {
      const response = await this.request(url, { method: 'POST', headers, body: payload, signal: combined });
      if (response.ok) return response;
      const text = await response.text().catch(() => '');
      if (process.env.ANTIGRAVITY_DEBUG_BODY) {
        console.error('[debug-body] failing request payload:', payload.slice(0, 200000));
      }
      throw this.#upstreamErrorFrom(response.status, text, account.id);
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      if (error.name === 'AbortError' || /aborted|timed? ?out/i.test(error.message)) {
        // timeout or client abort: do not retry
        throw new UpstreamError(`upstream timeout/abort: ${error.message}`, { status: 504, accountId: account.id, kind: 'other' });
      }
      preflightFailure = error;
    }
    // single pre-flight retry, on a fresh connection: the failed attempt most likely took a dead
    // pooled socket, and the pool can hold more of them (23.09 03:43: the retry hit one too)
    for (const agent of this.agents.values()) dropIdleSockets(agent);
    try {
      const response = await this.request(url, { method: 'POST', headers, body: payload, signal: combined });
      if (response.ok) return response;
      const text = await response.text().catch(() => '');
      throw this.#upstreamErrorFrom(response.status, text, account.id);
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError(`network error: ${preflightFailure?.message ?? error.message}`, { status: 502, accountId: account.id, kind: 'other' });
    }
  }

  #upstreamErrorFrom(status, text, accountId) {
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
}
