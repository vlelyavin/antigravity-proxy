import http from 'node:http';
import { checkApiKey, errorResponse, handleWithRotation } from './handlers.js';
import { modelsPayload } from '../rewrite/models.js';
import { UpstreamError } from '../upstream/upstream-client.js';

/**
 * Buffers the request body. `res` is written directly on the oversize path: the caller must see an
 * explicit 413 before the socket goes, and buffering the rest of a body we already rejected would
 * be pointless. Rejections carry clientAborted/tooLarge so the handler answers only when there is
 * somebody left to answer.
 */
export function readBody(req, res, limitBytes = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const settle = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    const aborted = (error = new Error('client disconnected')) => {
      error.clientAborted = true;
      settle(reject, error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limitBytes) {
        const body = JSON.stringify({ error: { message: 'request body too large', type: 'invalid_request_error', code: 413 } });
        res.writeHead(413, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' });
        // flush the rejection before the socket goes, so the client reads 413 and not ECONNRESET
        res.end(body, () => req.destroy());
        const error = new Error('request body too large');
        error.tooLarge = true;
        settle(reject, error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => settle(resolve, Buffer.concat(chunks).toString('utf8')));
    req.on('error', (error) => aborted(error));
    // 'close' also fires after 'end' (settled then); before it, the caller went away mid-upload
    req.on('close', () => { if (!settled) aborted(); });
  });
}

/**
 * Opt-in per-attempt budget, e.g. `x-attempt-timeouts-ms: 45000,30000` (Mari): the i-th account attempt
 * of a non-stream request is cut after the i-th value. Clamped to the upstream request timeout; an
 * unparsable header is ignored, so a bad value never breaks a call.
 */
function attemptTimeouts(req, config) {
  const raw = req.headers['x-attempt-timeouts-ms'];
  // 2026-10-19: без заголовка берём дефолт из rotation.attemptTimeoutsMs.
  // Иначе зависший апстрим держит клиента до общего таймаута вместо перехода
  // на следующий аккаунт - Мари видит таймаут там, где есть живые аккаунты.
  if (typeof raw !== 'string' || raw.trim() === '') {
    const dflt = config.rotation && config.rotation.attemptTimeoutsMs;
    return Array.isArray(dflt)
      ? dflt.map((v) => Math.min(v, config.upstream.requestTimeoutMs))
      : [];
  }
  const values = raw.split(',').map((v) => Number(v.trim()));
  if (values.some((v) => !Number.isInteger(v) || v <= 0)) return [];
  return values.map((v) => Math.min(v, config.upstream.requestTimeoutMs));
}

/**
 * The caller's disconnect. `req` emits 'close' as soon as its body has been read (Node >= 16), so a
 * caller that hangs up while waiting for the answer is only visible on the response: 'close' with
 * writableFinished unset means the connection died. A finished response is not a cancellation.
 */
function watchClientGone(res) {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableFinished) controller.abort(new Error('client disconnected'));
  };
  res.on('close', onClose);
  // the caller may already have left between its upload and this listener
  if (res.destroyed && !res.writableFinished) controller.abort(new Error('client disconnected'));
  return { signal: controller.signal, stop: () => res.removeListener('close', onClose) };
}

export function createServer({ config, credentialStore, upstream, pool, logger }) {
  const server = http.createServer((req, res) => {
    // top-level guard: one malformed request must never take the process down
    Promise.resolve(handle(req, res)).catch((error) => {
      logger.error('request.unhandled', { error: error.message });
      if (!res.headersSent) {
        try { errorResponse(res, 500, `internal error: ${error.message}`); } catch { /* socket gone */ }
      } else {
        try { res.end(); } catch { /* socket gone */ }
      }
    });
  });

  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      return errorResponse(res, 400, 'malformed request target');
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      if (!checkApiKey(config, req)) return errorResponse(res, 401, 'invalid api key', 'authentication_error');
      let accounts = [];
      let error = null;
      try { accounts = credentialStore.readAll(); } catch (e) { error = e.message; }
      const body = JSON.stringify({
        status: error ? 'degraded' : 'ok',
        accounts: accounts.map((a) => ({ email: a.email, project: a.projectId ? 'set' : 'missing', tokenExpiresAt: a.expiry ? new Date(a.expiry).toISOString() : null })),
        upstream: config.upstream.baseUrl,
        error,
      });
      res.writeHead(error ? 503 : 200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      if (!checkApiKey(config, req)) return errorResponse(res, 401, 'invalid api key', 'authentication_error');
      const body = JSON.stringify(modelsPayload());
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
      if (!checkApiKey(config, req)) return errorResponse(res, 401, 'invalid api key', 'authentication_error');
      let openAiBody;
      try {
        openAiBody = JSON.parse(await readBody(req, res));
      } catch (error) {
        // the 413 is already written; a caller that left mid-upload gets no answer
        if (error.tooLarge || error.clientAborted) return;
        return errorResponse(res, 400, `invalid JSON body: ${error.message}`);
      }
      if (!Array.isArray(openAiBody.messages) || openAiBody.messages.length === 0) {
        return errorResponse(res, 400, 'messages must be a non-empty array');
      }
      if (!openAiBody.model) openAiBody.model = 'gemini-3.8-flash-high';
      openAiBody.stream = openAiBody.stream === true;

      // abort upstream generation when the client goes away (quota protection)
      const client = watchClientGone(res);
      try {
        await handleWithRotation({
          pool, store: credentialStore, upstream, config, logger, openAiBody, req, res,
          signal: client.signal, attemptTimeoutsMs: attemptTimeouts(req, config),
        });
      } catch (error) {
        if (client.signal.aborted) {
          logger.warn('chat.client_aborted', { model: openAiBody.model });
          return;
        }
        const status = error instanceof UpstreamError
          ? error.status
          : (error.status === 400 ? 400 : 502);
        const type = status === 429 ? 'rate_limit_error' : status === 401 ? 'authentication_error' : 'server_error';
        logger.error('chat.failed', { status, error: error.message });
        if (!res.headersSent) errorResponse(res, status, error.message, type);
        else res.end();
      } finally {
        client.stop();
      }
      return;
    }

    // native Gemini generateContent (CPA parity): /v1beta/models/{model}:generateContent
    const nativeMatch = /^(?:\/v1beta\/models\/|\/v1\/(?:beta\/)?models\/)([^/:]+):generateContent$/.exec(url.pathname);
    if (req.method === 'POST' && nativeMatch) {
      if (!checkApiKey(config, req)) return errorResponse(res, 401, 'invalid api key', 'authentication_error');
      let nativeBody;
      try {
        nativeBody = JSON.parse(await readBody(req, res));
      } catch (error) {
        if (error.tooLarge || error.clientAborted) return;
        return errorResponse(res, 400, `invalid JSON body: ${error.message}`);
      }
      const model = decodeURIComponent(nativeMatch[1]);
      const { geminiNativeToOpenAi } = await import('../rewrite/gemini-native.js');
      const openAiBody = geminiNativeToOpenAi(nativeBody, { model });
      if (openAiBody.messages.length === 0) {
        return errorResponse(res, 400, 'contents must be a non-empty array');
      }
      const client = watchClientGone(res);
      try {
        await handleWithRotation({
          pool, store: credentialStore, upstream, config, logger,
          openAiBody, req, res, signal: client.signal,
          respondNative: true, attemptTimeoutsMs: attemptTimeouts(req, config),
        });
      } catch (error) {
        if (client.signal.aborted) {
          logger.warn('native.client_aborted', { model });
          return;
        }
        const status = error instanceof UpstreamError ? error.status : (error.status === 400 ? 400 : 502);
        logger.error('native.failed', { status, error: error.message });
        if (!res.headersSent) {
          errorResponse(res, status, error.message, status === 429 ? 'rate_limit_error' : 'server_error');
        } else res.end();
      } finally {
        client.stop();
      }
      return;
    }

    errorResponse(res, 404, `no route for ${req.method} ${url.pathname}`);
  }

  server.on('error', (error) => {
    logger.error('server.start_failed', { error: error.message });
    process.exitCode = 1;
  });

  return server;
}
