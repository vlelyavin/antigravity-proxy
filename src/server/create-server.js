import http from 'node:http';
import { checkApiKey, errorResponse, handleWithRotation } from './handlers.js';
import { modelsPayload } from '../rewrite/models.js';
import { UpstreamError } from '../upstream/upstream-client.js';

function readBody(req, limitBytes = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const fail = (message) => {
      if (done) return;
      done = true;
      reject(new Error(message));
    };
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limitBytes) {
        done = true;
        // answer before destroying so the client sees 413, not ECONNRESET
        res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ error: { message: 'request body too large', type: 'invalid_request_error', code: 413 } }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    const chunks = [];
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', (error) => fail(error.message));
  });
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
        openAiBody = JSON.parse(await readBody(req));
      } catch (error) {
        return errorResponse(res, 400, `invalid JSON body: ${error.message}`);
      }
      if (!Array.isArray(openAiBody.messages) || openAiBody.messages.length === 0) {
        return errorResponse(res, 400, 'messages must be a non-empty array');
      }
      if (!openAiBody.model) openAiBody.model = 'gemini-3.8-flash-high';
      openAiBody.stream = openAiBody.stream === true;

      // abort upstream generation when the client goes away (quota protection)
      const clientAbort = new AbortController();
      req.on('close', () => { if (!res.writableEnded) clientAbort.abort(new Error('client disconnected')); });

      try {
        await handleWithRotation({ pool, store: credentialStore, upstream, config, logger, openAiBody, req, res, signal: clientAbort.signal });
      } catch (error) {
        if (clientAbort.signal.aborted) {
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
