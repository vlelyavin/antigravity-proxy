import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { loadConfig } from '../src/config/load-config.js';
import { createLogger } from '../src/utils/logger.js';
import { CredentialStore } from '../src/credentials/credential-store.js';
import { UpstreamClient, UpstreamError } from '../src/upstream/upstream-client.js';
import { AccountPool } from '../src/upstream/account-pool.js';
import { createServer } from '../src/server/create-server.js';

const CONFIG = loadConfig({ env: { ANTIGRAVITY_PROXY_PORT: '0', ANTIGRAVITY_PROXY_LOG_LEVEL: 'error' } });

function fakeUpstream({ hangMs = 0, sse } = {}) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      if (parsed.request.contents[0].parts[0].text === 'TRIGGER_429' || parsed.project === 'p-exhausted') {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } }));
        return;
      }
      if (hangMs > 0) {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{}');
        }, hangMs);
        return;
      }
      if (req.url.includes('streamGenerateContent')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const frame of sse ?? [
          { response: { candidates: [{ content: { parts: [{ text: 'he' }] } }] } },
          { response: { candidates: [{ content: { parts: [{ text: 'y' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 } } },
        ]) {
          res.write(`data: ${JSON.stringify(frame)}\n\n`);
        }
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'pong' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 } } }));
    });
  });
}

async function startStack({ accounts, apiKey = null, upstreamOpts = {} } = {}) {
  const upstreamServer = fakeUpstream(upstreamOpts);
  await once(upstreamServer.listen(0), 'listening');
  const upstreamPort = upstreamServer.address().port;

  const logger = createLogger('error');
  const store = new CredentialStore({ searchPaths: [], logger });
  store.readAll = () => accounts;

  const config = {
    ...CONFIG,
    upstream: { ...CONFIG.upstream, baseUrl: `http://127.0.0.1:${upstreamPort}`, apiVersion: 'v1internal', eagerRefreshMs: 0, egress: { url: null } },
    apiKey,
  };
  const upstreamClient = new UpstreamClient({ config, logger });
  upstreamClient.accessToken = async () => 'test-token';

  const pool = new AccountPool({ logger });
  const server = createServer({ config, credentialStore: store, upstream: upstreamClient, pool, logger });
  await once(server.listen(0), 'listening');
  const port = server.address().port;
  return { server, upstreamServer, port, pool, upstreamClient };
}

async function post(port, path, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('malformed request target does not crash the server (C1)', async () => {
  const stack = await startStack({ accounts: [{ id: 'c1', projectId: 'p' }] });
  try {
    // raw socket with a broken request line
    const socket = net.connect({ host: '127.0.0.1', port: stack.port });
    await once(socket, 'connect');
    socket.write('GET /% HTTP/1.1\r\nHost: x\r\n\r\n');
    const resp = await new Promise((resolve) => {
      let data = '';
      socket.on('data', (c) => { data += c; resolve(data); });
    });
    assert.match(resp, /(400|404) /); // no crash, structured response
    socket.end();
    // server still alive:
    const health = await fetch(`http://127.0.0.1:${stack.port}/health`);
    assert.equal(health.status, 200);
  } finally {
    stack.server.close(); stack.upstreamServer.close();
  }
});

test('request timeout produces 504, not a hang (C2)', async () => {
  const stack = await startStack({
    accounts: [{ id: 't1', projectId: 'p' }],
    upstreamOpts: { hangMs: 5000 },
  });
  stack.upstreamClient.config.upstream.requestTimeoutMs = 300; // small for the test
  try {
    const res = await post(stack.port, '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 504);
  } finally {
    stack.server.close(); stack.upstreamServer.close();
  }
});

test('client disconnect aborts upstream stream (C4, quota burn guard)', async () => {
  let sawEnd = false;
  const upstreamServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // long dribble
    let n = 0;
    const iv = setInterval(() => {
      res.write(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'x' }] } }] } })}\n\n`);
      if (++n > 50) { clearInterval(iv); res.end(); sawEnd = true; }
    }, 50);
    req.on('close', () => clearInterval(iv));
  });
  await once(upstreamServer.listen(0), 'listening');
  const upstreamPort = upstreamServer.address().port;

  const logger = createLogger('error');
  const store = new CredentialStore({ searchPaths: [], logger });
  store.readAll = () => [{ id: 'a1', projectId: 'p' }];
  const config = { ...CONFIG, upstream: { ...CONFIG.upstream, baseUrl: `http://127.0.0.1:${upstreamPort}`, apiVersion: 'v1internal', egress: { url: null } } };
  const upstreamClient = new UpstreamClient({ config, logger });
  upstreamClient.accessToken = async () => 'test-token';
  const pool = new AccountPool({ logger });
  const server = createServer({ config, credentialStore: store, upstream: upstreamClient, pool, logger });
  await once(server.listen(0), 'listening');
  const port = server.address().port;

  try {
    const net = await import('node:net');
    const socket = net.connect({ host: '127.0.0.1', port });
    await once(socket, 'connect');
    socket.write(`POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] }).length}\r\n\r\n${JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] })}`);
    await new Promise((r) => setTimeout(r, 300)); // got a few frames
    socket.destroy(); // client drops
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(sawEnd, false, 'upstream stream should have been aborted before finishing');
  } finally {
    server.close(); upstreamServer.close();
    clearInterval && null;
  }
});

test('mid-stream failure emits error frame + [DONE] (H4)', async () => {
  const upstreamServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'part' }] } }] } })}\n\n`);
    setTimeout(() => res.destroy(), 50); // hard upstream failure mid-stream
  });
  await once(upstreamServer.listen(0), 'listening');
  const upstreamPort = upstreamServer.address().port;

  const logger = createLogger('error');
  const store = new CredentialStore({ searchPaths: [], logger });
  store.readAll = () => [{ id: 'a2', projectId: 'p' }];
  const config = { ...CONFIG, upstream: { ...CONFIG.upstream, baseUrl: `http://127.0.0.1:${upstreamPort}`, apiVersion: 'v1internal', egress: { url: null } } };
  const upstreamClient = new UpstreamClient({ config, logger });
  upstreamClient.accessToken = async () => 'test-token';
  const pool = new AccountPool({ logger });
  const server = createServer({ config, credentialStore: store, upstream: upstreamClient, pool, logger });
  await once(server.listen(0), 'listening');
  const port = server.address().port;

  try {
    const raw = net.connect({ host: '127.0.0.1', port });
    await once(raw, 'connect');
    const body = JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    raw.write(`POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
    const text = await new Promise((resolve) => {
      let data = '';
      raw.on('data', (c) => { data += c; });
      raw.on('close', () => resolve(data));
    });
    assert.match(text, /upstream stream failed/);
    assert.match(text, /\[DONE\]/);
  } finally {
    server.close(); upstreamServer.close();
  }
});

test('all-accounts-cooling fails fast with 429 (M9)', async () => {
  const stack = await startStack({
    accounts: [{ id: 'q1', projectId: 'p' }],
  });
  stack.pool.cooldown('q1', 60_000);
  try {
    const res = await post(stack.port, '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 429);
  } finally {
    stack.server.close(); stack.upstreamServer.close();
  }
});

test('429 rotates to the second account (kind=quota)', async () => {
  const stack = await startStack({
    accounts: [
      { id: 'q1', email: 'dead@x', projectId: 'p-exhausted' },
      { id: 'q2', email: 'alive@x', projectId: 'p' },
    ],
  });
  try {
    // q1 is picked first and answers 429: the same request moves on to q2
    const res = await post(stack.port, '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.choices[0].message.content, 'pong');
    // and q1 sits out its cooldown
    assert.deepEqual(stack.pool.healthy([{ id: 'q1' }, { id: 'q2' }]).map((a) => a.id), ['q2']);
  } finally {
    stack.server.close(); stack.upstreamServer.close();
  }
});

test('health is api-key gated when configured (L8)', async () => {
  const stack = await startStack({ accounts: [{ id: 'k1', projectId: 'p' }], apiKey: 'sk-secret' });
  try {
    const noKey = await fetch(`http://127.0.0.1:${stack.port}/health`);
    assert.equal(noKey.status, 401);
    const withKey = await fetch(`http://127.0.0.1:${stack.port}/health`, { headers: { authorization: 'Bearer sk-secret' } });
    assert.equal(withKey.status, 200);
  } finally {
    stack.server.close(); stack.upstreamServer.close();
  }
});
