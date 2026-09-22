import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { loadConfig } from '../src/config/load-config.js';
import { createLogger } from '../src/utils/logger.js';
import { CredentialStore } from '../src/credentials/credential-store.js';
import { UpstreamClient } from '../src/upstream/upstream-client.js';
import { AccountPool } from '../src/upstream/account-pool.js';
import { createServer } from '../src/server/create-server.js';
import { isGeminiFamily, vertexModelName } from '../src/upstream/vertex-fallback.js';

const CONFIG = loadConfig({ env: { ANTIGRAVITY_PROXY_PORT: '0', ANTIGRAVITY_PROXY_LOG_LEVEL: 'error' } });

// fake antigravity upstream: 429 on TRIGGER_429, normal reply otherwise
function fakeUpstream() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      if (parsed.request?.contents?.[0]?.parts?.[0]?.text === 'TRIGGER_429') {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 429, message: 'Resource exhausted', status: 'RESOURCE_EXHAUSTED' } }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'pong' }] }, finishReason: 'STOP' }] } }));
      }
    });
  });
}

// fake vertex relay: records requests, responds openai-json (or fails/hangs per opts)
function fakeVertex({ status = 200, reply = 'vertex-ok', hang = false } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ url: req.url, body: JSON.parse(body) });
      if (hang) return; // never respond -> client timeout
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'vertex dead' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-vtx', object: 'chat.completion', created: 1, model: 'gemini-3.8-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  return { server, calls };
}

async function startStack({ accounts, vertexOpts = {}, fallbackEnabled = true } = {}) {
  const upstreamServer = fakeUpstream();
  await once(upstreamServer.listen(0), 'listening');

  const vertex = fakeVertex(vertexOpts);
  await once(vertex.server.listen(0), 'listening');
  const vertexUrl = `http://127.0.0.1:${vertex.server.address().port}/v1/chat/completions`;

  const logger = createLogger('error');
  const store = new CredentialStore({ searchPaths: [], logger });
  store.readAll = () => accounts;

  const config = {
    ...CONFIG,
    upstream: { ...CONFIG.upstream, baseUrl: `http://127.0.0.1:${upstreamServer.address().port}`, apiVersion: 'v1internal', eagerRefreshMs: 0, egress: { url: null } },
    fallback: { vertexUrl, enabled: fallbackEnabled, timeoutMs: vertexOpts.timeoutMs ?? 5000 },
  };
  const upstreamClient = new UpstreamClient({ config, logger });
  upstreamClient.accessToken = async () => 'test-token';

  const pool = new AccountPool({ logger });
  const server = createServer({ config, credentialStore: store, upstream: upstreamClient, pool, logger });
  await once(server.listen(0), 'listening');
  return { server, upstreamServer, vertex, port: server.address().port, pool, store };
}

async function post(port, body) {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

const ONE_ACCOUNT = [{ id: 'a1', email: 'a@x', projectId: 'p', refreshToken: 'r', accessToken: 't', expiry: null }];
const GEMINI_429 = { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'TRIGGER_429' }] };

test('isGeminiFamily / vertexModelName', () => {
  assert.equal(isGeminiFamily('gemini-3.8-flash-high'), true);
  assert.equal(isGeminiFamily('Gemini-3-pro'), true);
  assert.equal(isGeminiFamily('m'), false);
  assert.equal(isGeminiFamily('claude-sonnet-4'), false);
  assert.equal(vertexModelName('gemini-3.8-flash-high'), 'gemini-3.8-flash');
  assert.equal(vertexModelName('gemini-3.8-flash-medium'), 'gemini-3.8-flash');
  assert.equal(vertexModelName('gemini-3.8-flash-low'), 'gemini-3.8-flash');
  assert.equal(vertexModelName('gemini-3.8-flash'), 'gemini-3.8-flash');
});

test('pool exhausted -> vertex fallback answers, request normalized + response_format preserved', async () => {
  const stack = await startStack({ accounts: ONE_ACCOUNT });
  try {
    const res = await post(stack.port, {
      ...GEMINI_429,
      response_format: { type: 'json_schema', json_schema: { name: 's', strict: true, schema: { type: 'object' } } },
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.choices[0].message.content, 'vertex-ok');
    assert.equal(stack.vertex.calls.length, 1);
    const sent = stack.vertex.calls[0].body;
    assert.equal(sent.model, 'gemini-3.8-flash'); // effort suffix stripped
    assert.equal(sent.stream, false);
    assert.deepEqual(sent.response_format.json_schema.schema, { type: 'object' });
    assert.equal(sent.messages[0].content, 'TRIGGER_429');
  } finally {
    stack.server.close(); stack.upstreamServer.close(); stack.vertex.server.close();
  }
});

test('non-gemini model -> no fallback, upstream 429 propagates', async () => {
  const stack = await startStack({ accounts: ONE_ACCOUNT });
  try {
    const res = await post(stack.port, { model: 'm', messages: [{ role: 'user', content: 'TRIGGER_429' }] });
    assert.equal(res.status, 429);
    assert.equal(stack.vertex.calls.length, 0);
  } finally {
    stack.server.close(); stack.upstreamServer.close(); stack.vertex.server.close();
  }
});

test('fallback disabled -> upstream 429 propagates', async () => {
  const stack = await startStack({ accounts: ONE_ACCOUNT, fallbackEnabled: false });
  try {
    const res = await post(stack.port, GEMINI_429);
    assert.equal(res.status, 429);
    assert.equal(stack.vertex.calls.length, 0);
  } finally {
    stack.server.close(); stack.upstreamServer.close(); stack.vertex.server.close();
  }
});

test('fallback itself fails -> original pool error propagates', async () => {
  const stack = await startStack({ accounts: ONE_ACCOUNT, vertexOpts: { status: 500 } });
  try {
    const res = await post(stack.port, GEMINI_429);
    assert.equal(res.status, 429); // pool error wins, not the vertex 500
    assert.equal(stack.vertex.calls.length, 1);
  } finally {
    stack.server.close(); stack.upstreamServer.close(); stack.vertex.server.close();
  }
});

test('fallback timeout -> original pool error propagates', async () => {
  const stack = await startStack({ accounts: ONE_ACCOUNT, vertexOpts: { hang: true, timeoutMs: 200 } });
  try {
    const res = await post(stack.port, GEMINI_429);
    assert.equal(res.status, 429);
    assert.equal(stack.vertex.calls.length, 1);
  } finally {
    stack.server.close(); stack.upstreamServer.close(); stack.vertex.server.close();
  }
});

test('stream request -> fallback answers as valid SSE (single chunk + DONE)', async () => {
  const stack = await startStack({ accounts: ONE_ACCOUNT });
  try {
    const res = await post(stack.port, { ...GEMINI_429, stream: true });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /"vertex-ok"/);
    assert.match(text, /data: \[DONE\]/);
    assert.equal(stack.vertex.calls.length, 1);
    assert.equal(stack.vertex.calls[0].body.stream, false); // sent unary upstream
  } finally {
    stack.server.close(); stack.upstreamServer.close(); stack.vertex.server.close();
  }
});

test('all accounts cooling down -> fallback used', async () => {
  const stack = await startStack({ accounts: ONE_ACCOUNT });
  stack.pool.cooldown('a1', 60_000);
  try {
    const res = await post(stack.port, { model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.choices[0].message.content, 'vertex-ok');
  } finally {
    stack.server.close(); stack.upstreamServer.close(); stack.vertex.server.close();
  }
});

test('empty credential store (readAll throws) -> fallback used', async () => {
  const stack = await startStack({ accounts: [] });
  // simulate missing credential files: readAll throws instead of returning []
  stack.store.readAll = () => { throw new Error('no antigravity token files found'); };
  try {
    const res = await post(stack.port, { model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.choices[0].message.content, 'vertex-ok');
    assert.equal(stack.vertex.calls.length, 1);
  } finally {
    stack.server.close(); stack.upstreamServer.close(); stack.vertex.server.close();
  }
});

test('pool success -> fallback NOT called', async () => {
  const stack = await startStack({ accounts: ONE_ACCOUNT });
  try {
    const res = await post(stack.port, { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.choices[0].message.content, 'pong');
    assert.equal(stack.vertex.calls.length, 0);
  } finally {
    stack.server.close(); stack.upstreamServer.close(); stack.vertex.server.close();
  }
});
