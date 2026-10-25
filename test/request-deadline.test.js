import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { loadConfig } from '../src/config/load-config.js';
import { createLogger } from '../src/utils/logger.js';
import { UpstreamClient } from '../src/upstream/upstream-client.js';
import { AccountPool } from '../src/upstream/account-pool.js';
import { createServer } from '../src/server/create-server.js';

const CONFIG = loadConfig({ env: { ANTIGRAVITY_PROXY_PORT: '0', ANTIGRAVITY_PROXY_LOG_LEVEL: 'error' } });

const ACCOUNTS = [
  { id: 'a0', email: 'first@example.com', projectId: 'p' },
  { id: 'a1', email: 'second@example.com', projectId: 'p' },
];

function recorder() {
  const events = [];
  const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((level) => [
    level, (event, data = {}) => events.push({ level, event, ...data }),
  ]));
  return { logger, events };
}

/** An upstream that accepts the request, sends headers, then never finishes (optionally keepalives). */
function silentUpstream({ keepaliveMs = 0 } = {}) {
  const starts = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      starts.push(Date.now());
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (keepaliveMs > 0) {
        // frames carrying nothing: no content, no finish reason, no refusal
        const timer = setInterval(() => res.write(`data: ${JSON.stringify({ response: {} })}\n\n`), keepaliveMs);
        res.on('close', () => clearInterval(timer));
      }
    });
  });
  return { server, starts };
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

async function startStack({ rotation = {}, keepaliveMs = 0, fallback = { enabled: false }, accounts = ACCOUNTS } = {}) {
  const { logger, events } = recorder();
  const upstreamServer = silentUpstream({ keepaliveMs });
  await once(upstreamServer.server.listen(0), 'listening');
  const vertex = fakeVertex();
  await once(vertex.server.listen(0), 'listening');
  const config = {
    ...CONFIG,
    upstream: {
      ...CONFIG.upstream,
      baseUrl: `http://127.0.0.1:${upstreamServer.server.address().port}`,
      apiVersion: 'v1internal',
      requestTimeoutMs: 5000,
      eagerRefreshMs: 0,
      egress: { url: null },
    },
    rotation: { ...CONFIG.rotation, cooldownMs: 45_000, ...rotation },
    fallback: fallback.enabled
      ? { enabled: true, vertexUrl: `http://127.0.0.1:${vertex.server.address().port}/v1/chat/completions`, timeoutMs: 5000 }
      : { enabled: false },
  };
  const client = new UpstreamClient({ config, logger });
  client.accessToken = async () => 'test-token';
  const pool = new AccountPool({ logger });
  const server = createServer({ config, credentialStore: { readAll: () => accounts }, upstream: client, pool, logger });
  await once(server.listen(0), 'listening');
  const close = () => {
    for (const s of [server, upstreamServer.server, vertex.server]) { s.closeAllConnections(); s.close(); }
  };
  return { port: server.address().port, pool, events, starts: upstreamServer.starts, vertexCalls: vertex.calls, close };
}

async function chat(port, headers = {}) {
  const startedAt = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'gemini-3.8-flash-low', messages: [{ role: 'user', content: 'hi' }] }),
  });
  const text = await res.text();
  return { status: res.status, text, elapsedMs: Date.now() - startedAt };
}

test('the request deadline bounds a hanging pool and cools no account', async () => {
  const stack = await startStack({ rotation: { requestDeadlineMs: 400, attemptTimeoutsMs: [1000, 1000] } });
  try {
    const res = await chat(stack.port);
    assert.equal(res.status, 504);
    assert.match(res.text, /request deadline/);
    assert.ok(res.elapsedMs >= 350 && res.elapsedMs < 2000, `elapsed ${res.elapsedMs}ms`);
    assert.equal(stack.starts.length, 1, 'a spent budget starts no further account');
    assert.equal(stack.pool.healthy(ACCOUNTS).length, 2, 'a deadline is not an upstream failure');
    assert.ok(!stack.events.some((e) => e.event === 'account.cooldown'));
    const attempt = stack.events.find((e) => e.event === 'attempt.timing');
    assert.equal(attempt.outcome, 'deadline');
    assert.equal(attempt.status, 504);
    assert.equal(attempt.account, 'acct-0');
    const request = stack.events.find((e) => e.event === 'request.timing');
    assert.equal(request.outcome, 'deadline');
    assert.equal(request.attempts, 1);
    assert.ok(request.totalMs >= 350 && request.totalMs < 2000);
    assert.equal(request.deadlineMs, 400);
  } finally {
    stack.close();
  }
});

test('an attempt cut leaves the rest of the deadline for the next account, not a fresh ladder value', async () => {
  // first attempt 100 ms, second would get its own 5000 ms ladder value: the deadline caps it at ~200 ms
  const stack = await startStack({ rotation: { requestDeadlineMs: 300, attemptTimeoutsMs: [100, 5000] } });
  try {
    const res = await chat(stack.port);
    assert.equal(res.status, 504);
    assert.equal(stack.starts.length, 2, 'the second account still gets a try');
    assert.ok(stack.starts[1] - stack.starts[0] >= 80, 'the first attempt really was cut');
    assert.ok(res.elapsedMs < 1500, `the second attempt must not get its 5000 ms: elapsed ${res.elapsedMs}ms`);
    const request = stack.events.find((e) => e.event === 'request.timing');
    assert.equal(request.outcome, 'deadline');
    assert.equal(request.attempts, 2);
  } finally {
    stack.close();
  }
});

test('keepalive frames neither extend the deadline nor count as the first meaningful frame', async () => {
  const stack = await startStack({ keepaliveMs: 40, rotation: { requestDeadlineMs: 400, attemptTimeoutsMs: [10_000] } });
  try {
    const res = await chat(stack.port);
    assert.equal(res.status, 504);
    assert.ok(res.elapsedMs < 2000, `keepalives must not buy a fresh budget: elapsed ${res.elapsedMs}ms`);
    const attempt = stack.events.find((e) => e.event === 'attempt.timing');
    assert.equal(attempt.outcome, 'deadline');
    assert.equal(attempt.firstFrameMs, null, 'a frame with no content is not a first meaningful frame');
    assert.equal(typeof attempt.prepMs, 'number', 'headers did arrive, so preparation is timed');
  } finally {
    stack.close();
  }
});

test('a spent deadline never starts the Vertex fallback', async () => {
  const stack = await startStack({
    rotation: { requestDeadlineMs: 300, attemptTimeoutsMs: [10_000] },
    fallback: { enabled: true },
  });
  try {
    const res = await chat(stack.port);
    assert.equal(res.status, 504);
    assert.equal(stack.vertexCalls.length, 0);
    assert.ok(!stack.events.some((e) => e.event === 'vertex_fallback.attempt'));
  } finally {
    stack.close();
  }
});

test('timings carry the request id and an anonymised account, never the email', async () => {
  const stack = await startStack({ rotation: { requestDeadlineMs: 300, attemptTimeoutsMs: [10_000] } });
  try {
    const res = await chat(stack.port, { 'x-request-id': 'probe-request-1' });
    assert.equal(res.status, 504);
    const request = stack.events.find((e) => e.event === 'request.timing');
    assert.equal(request.requestId, 'probe-request-1');
    assert.equal(typeof request.status, 'number');
    assert.equal(typeof request.reason, 'string');
    const attempt = stack.events.find((e) => e.event === 'attempt.timing');
    for (const field of ['prepMs', 'firstFrameMs', 'totalMs']) assert.ok(field in attempt, `attempt.timing lacks ${field}`);
    assert.equal(attempt.account, 'acct-0');
    const timingLines = stack.events.filter((e) => /^attempt\.timing$|^request\.timing$/.test(e.event));
    assert.ok(timingLines.length >= 2);
    assert.ok(!JSON.stringify(timingLines).includes('@example.com'), 'the timing lines never carry an account email');
  } finally {
    stack.close();
  }
});
