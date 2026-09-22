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

const CONFIG = loadConfig({ env: { ANTIGRAVITY_PROXY_PORT: '0', ANTIGRAVITY_PROXY_LOG_LEVEL: 'error' } });

// fake upstream Cloud Code backend: answers generateContent and SSE stream
function fakeUpstream() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      if (req.url.includes('streamGenerateContent')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'he' }] } }] } })}\n\n`);
        res.write(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'y' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 } } })}\n\n`);
        res.end();
      } else if (parsed.request.contents[0].parts[0].text === 'TRIGGER_429') {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } }));
      } else {
        const reply = parsed.request.contents[0].parts[0].text === 'ECHO_MODEL'
          ? `MODEL:${parsed.model}`
          : 'pong';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: reply }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 } } }));
      }
    });
  });
}

async function startStack({ accounts, apiKey = null } = {}) {
  const upstreamServer = fakeUpstream();
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
  // stub refresh: access token comes back as 'test-token'
  const upstreamClient = new UpstreamClient({ config, logger });
  upstreamClient.accessToken = async () => 'test-token';

  const pool = new AccountPool({ logger });
  const server = createServer({ config, credentialStore: store, upstream: upstreamClient, pool, logger });
  await once(server.listen(0), 'listening');
  const port = server.address().port;
  return { server, upstreamServer, port, pool };
}

async function post(port, path, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return res;
}

test('non-stream chat completion round-trips through the fake upstream', async () => {
  const stack = await startStack({ accounts: [{ id: 'f1', email: 'a@x', projectId: 'p', refreshToken: 'r', accessToken: 't', expiry: null }] });
  try {
    const res = await post(stack.port, '/v1/chat/completions', { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.choices[0].message.content, 'pong');
    assert.equal(json.usage.total_tokens, 3);
  } finally {
    stack.server.close(); stack.upstreamServer.close();
  }
});

test('stream chat completion emits OpenAI SSE chunks + [DONE]', async () => {
  const stack = await startStack({ accounts: [{ id: 'f2', email: 'a@x', projectId: 'p', refreshToken: 'r', accessToken: 't', expiry: null }] });
  try {
    const res = await post(stack.port, '/v1/chat/completions', { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /"content":"he"/);
    assert.match(text, /"content":"y"/);
    assert.match(text, /\[DONE\]/);
    assert.match(text, /"finish_reason":"stop"/);
  } finally {
    stack.server.close(); stack.upstreamServer.close();
  }
});

test('429 rotates to the second account', async () => {
  const stack = await startStack({
    accounts: [
      { id: 'q1', email: 'dead@x', projectId: 'p', refreshToken: 'r', accessToken: 't', expiry: null },
      { id: 'q2', email: 'alive@x', projectId: 'p', refreshToken: 'r', accessToken: 't', expiry: null },
    ],
  });
  try {
    // q1 selected first; its generate hits TRIGGER_429 via content text
    const res = await post(stack.port, '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'TRIGGER_429' }] });
    // the second attempt posts the same body to the same fake upstream, which still 429s
    // -> rotation exhausted, response carries the upstream 429
    assert.equal(res.status, 429);
    // q1 must now be cooling down: next pick is q2, which answers normally
    const res2 = await post(stack.port, '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res2.status, 200);
    const json = await res2.json();
    assert.equal(json.choices[0].message.content, 'pong');
  } finally {
    stack.server.close(); stack.upstreamServer.close();
  }
});

test('api key enforced when configured', async () => {
  const stack = await startStack({ accounts: [{ id: 'k1', projectId: 'p' }], apiKey: 'sk-secret' });
  try {
    const noKey = await post(stack.port, '/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(noKey.status, 401);
    const withKey = await post(stack.port, '/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }, { authorization: 'Bearer sk-secret' });
    assert.equal(withKey.status, 200);
    const withXGoog = await post(stack.port, '/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }, { 'x-goog-api-key': 'sk-secret' });
    assert.equal(withXGoog.status, 200);
  } finally {
    stack.server.close(); stack.upstreamServer.close();
  }
});

test('/health reports accounts; /v1/models lists catalog', async () => {
  const stack = await startStack({ accounts: [{ id: 'h1', email: 'e@x', projectId: 'p' }] });
  try {
    const health = await fetch(`http://127.0.0.1:${stack.port}/health`);
    const healthJson = await health.json();
    assert.equal(health.status, 200);
    assert.equal(healthJson.accounts[0].email, 'e@x');
    const models = await fetch(`http://127.0.0.1:${stack.port}/v1/models`);
    const modelsJson = await models.json();
    assert.ok(modelsJson.data.some((m) => m.id === 'gemini-3.8-flash-high'));
  } finally {
    stack.server.close(); stack.upstreamServer.close();
  }
});
