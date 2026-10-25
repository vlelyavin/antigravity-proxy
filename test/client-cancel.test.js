import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { loadConfig } from '../src/config/load-config.js';
import { createLogger } from '../src/utils/logger.js';
import { UpstreamClient , generationOf} from '../src/upstream/upstream-client.js';
import { AccountPool } from '../src/upstream/account-pool.js';
import { createServer } from '../src/server/create-server.js';
import { accountLabel } from '../src/utils/alias.js';

const CONFIG = loadConfig({ env: { ANTIGRAVITY_PROXY_PORT: '0', ANTIGRAVITY_PROXY_LOG_LEVEL: 'error' } });

function recorder() {
  const events = [];
  const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((level) => [
    level, (event, data = {}) => events.push({ level, event, ...data }),
  ]));
  return { logger, events };
}

async function until(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('condition was not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function sse(frames) {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function fakeVertex() {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'vertex' }, finish_reason: 'stop' }] }));
    });
  });
  return { server, calls };
}

test('an already cancelled request starts no credential or body preparation', async () => {
  const client = new UpstreamClient({ currentGeneration: generationOf, config: CONFIG, logger: createLogger('error') });
  let preparationCalls = 0;
  client.accessToken = async () => { preparationCalls++; return 'synthetic-token'; };
  client.buildBody = async () => { preparationCalls++; return {}; };
  const leaving = new AbortController();
  const reason = new Error('client disconnected');
  leaving.abort(reason);
  for (const method of ['generate', 'generateStream']) {
    await assert.rejects(client[method]({ openAiBody: {}, account: {}, signal: leaving.signal }), (error) => error === reason);
  }
  assert.equal(preparationCalls, 0);
});

test('a caller that hangs up while the answer is pending cancels the upstream and cools no account', async () => {
  const { logger, events } = recorder();
  const accounts = [
    { generation: 'synthetic', id: 'a0', email: 'first@example.com', projectId: 'p' },
    { generation: 'synthetic', id: 'a1', email: 'second@example.com', projectId: 'p' },
  ];
  const vertex = fakeVertex();
  await once(vertex.server.listen(0), 'listening');
  let attempts = 0;
  let upstreamSignal = null;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const upstream = {
    invalidate() {},
    async generateStream({ signal }) {
      attempts += 1;
      upstreamSignal = signal;
      markStarted();
      // like the real client: the abort tears the pending request down
      await new Promise((resolve, reject) => {
        pending.then(resolve);
        signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
      });
      return sse([{ response: { candidates: [{ content: { parts: [{ text: 'late' }] }, finishReason: 'STOP' }] } }]);
    },
  };
  const pool = new AccountPool({ logger });
  const server = createServer({
    config: {
      ...CONFIG,
      fallback: { enabled: true, vertexUrl: `http://127.0.0.1:${vertex.server.address().port}/v1/chat/completions`, timeoutMs: 2000 },
    },
    credentialStore: { readAll: () => accounts },
    upstream,
    pool,
    logger,
  });
  await once(server.listen(0), 'listening');
  try {
    const client = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, (res) => res.resume());
    client.on('error', () => {});
    client.end(JSON.stringify({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }] }));
    await started;
    assert.equal(upstreamSignal.aborted, false);

    client.destroy(); // the caller went away after its upload, while the upstream was generating
    await until(() => upstreamSignal.aborted);
    await until(() => events.some((e) => e.event === 'chat.client_aborted'));

    assert.deepEqual(pool.healthy(accounts).map((a) => a.id), ['a0', 'a1'], 'a caller that left is not an upstream failure');
    assert.equal(attempts, 1, 'a cancelled caller never starts another account');
    assert.equal(vertex.calls.length, 0, 'nor does it start the fallback');
    assert.ok(!events.some((e) => e.event === 'pool.restriction'));
    assert.ok(!events.some((e) => e.event === 'attempt.timing' && e.failureReason && e.failureReason !== 'client_cancelled'));
    const attempt = events.find((e) => e.event === 'attempt.timing');
    assert.equal(attempt.outcome, 'client_abort');
    assert.equal(attempt.account, accountLabel(accounts[0]));
  } finally {
    release();
    server.closeAllConnections();
    server.close();
    vertex.server.closeAllConnections();
    vertex.server.close();
  }
});

test('a caller that hangs up mid-upload never reaches the upstream and leaves the relay serving', async () => {
  const { logger } = recorder();
  let attempts = 0;
  const upstream = {
    invalidate() {},
    async generateStream() {
      attempts += 1;
      return sse([{ response: { candidates: [{ content: { parts: [{ text: 'nobody asked' }] }, finishReason: 'STOP' }] } }]);
    },
  };
  const server = createServer({
    config: { ...CONFIG, fallback: { enabled: false } },
    credentialStore: { readAll: () => [{ generation: 'synthetic', id: 'a0', projectId: 'p' }] },
    upstream,
    pool: new AccountPool({ logger }),
    logger,
  });
  await once(server.listen(0), 'listening');
  try {
    const socket = net.connect({ host: '127.0.0.1', port: server.address().port });
    await once(socket, 'connect');
    // a declared body that never arrives: the caller drops the connection mid-upload
    socket.write('POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 4096\r\n\r\n{"model":');
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(attempts, 0, 'no upstream request is started for a body that never arrived');
    const health = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    assert.equal(health.status, 200, 'the relay still answers');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('a cancelled caller does not cancel the shared token refresh of another caller', async () => {
  const logger = createLogger('error');
  const frame = { response: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] } };
  const upstreamServer = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify(frame)}\n\n`);
    });
  });
  await once(upstreamServer.listen(0), 'listening');
  const config = {
    ...CONFIG,
    upstream: {
      ...CONFIG.upstream,
      baseUrl: `http://127.0.0.1:${upstreamServer.address().port}`,
      apiVersion: 'v1internal',
      requestTimeoutMs: 2000,
      egress: { url: null },
    },
  };
  const client = new UpstreamClient({ currentGeneration: generationOf, config, logger });
  let refreshes = 0;
  const oauthFetch = async () => {
    refreshes += 1;
    await new Promise((resolve) => setTimeout(resolve, 120));
    return { ok: true, status: 200, json: async () => ({ access_token: 'fresh-token', expires_in: 3600 }) };
  };
  const account = { generation: 'synthetic', id: 'shared', email: 'person@example.com', projectId: 'p', refreshToken: 'refresh', expiry: null };
  const openAiBody = { model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }] };
  const leaving = new AbortController();
  try {
    const cancelled = client.generateStream({ openAiBody, account, fetchImpl: oauthFetch, signal: leaving.signal })
      .then(() => null, (error) => error);
    const kept = client.generateStream({ openAiBody, account, fetchImpl: oauthFetch });
    setTimeout(() => leaving.abort(new Error('client disconnected')), 30);
    const [cancelledResult, response] = await Promise.all([cancelled, kept]);
    assert.ok(cancelledResult instanceof Error, 'the caller that left is released');
    assert.equal(refreshes, 1, 'one shared refresh: not two, and not aborted by the caller that left');
    assert.equal(response.ok, true);
    assert.equal(client.tokens.get('shared')?.token, 'fresh-token');
  } finally {
    upstreamServer.closeAllConnections();
    upstreamServer.close();
  }
});
