import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { loadConfig } from '../src/config/load-config.js';
import { createLogger } from '../src/utils/logger.js';
import { CredentialStore } from '../src/credentials/credential-store.js';
import { UpstreamClient , generationOf} from '../src/upstream/upstream-client.js';
import { AccountPool } from '../src/upstream/account-pool.js';
import { createServer } from '../src/server/create-server.js';

const CONFIG = loadConfig({ env: { ANTIGRAVITY_PROXY_CONFIG: 'test/fixtures/empty-config.json', ANTIGRAVITY_PROXY_PORT: '0', ANTIGRAVITY_PROXY_LOG_LEVEL: 'error' } });

// fake upstream Cloud Code backend: answers generateContent and SSE stream
function fakeUpstream() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      // writeTrajectoryAcls: no request envelope, just acknowledge
      if (parsed.trajectoryId) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      if (parsed.project === 'p-tos') {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            code: 403,
            status: 'PERMISSION_DENIED',
            message: 'blocked',
            details: [{ reason: 'TOS_VIOLATION', metadata: { appeal_url: 'https://forms.gle/example' } }],
          },
        }));
        return;
      }
      if (parsed.request.contents[0].parts[0].text.includes('TRIGGER_429') || parsed.project === 'p-exhausted') {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } }));
        return;
      }
      if (req.url.includes('streamGenerateContent')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'he' }] } }] } })}\n\n`);
        res.write(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'y' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 } } })}\n\n`);
        res.end();
      } else {
        const reply = parsed.request.contents[0].parts[0].text.includes('ECHO_MODEL')
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
  const upstreamClient = new UpstreamClient({ currentGeneration: generationOf, config, logger });
  upstreamClient.accessToken = async () => 'test-token';

  const pool = new AccountPool({ logger });
  const server = createServer({ config, credentialStore: store, upstream: upstreamClient, pool, logger });
  await once(server.listen(0), 'listening');
  const port = server.address().port;
  return { server, upstreamServer, port, pool, upstreamClient };
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
  const stack = await startStack({ accounts: [{ generation: 'synthetic', id: 'f1', email: 'a@x', projectId: 'p', refreshToken: 'r', accessToken: 't', expiry: null }] });
  try {
    const res = await post(stack.port, '/v1/chat/completions', { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.choices[0].message.content, 'hey');
    assert.equal(json.usage.total_tokens, 4);
  } finally {
    stack.server.close(); stack.upstreamServer.close();
  }
});

test('stream chat completion emits OpenAI SSE chunks + [DONE]', async () => {
  const stack = await startStack({ accounts: [{ generation: 'synthetic', id: 'f2', email: 'a@x', projectId: 'p', refreshToken: 'r', accessToken: 't', expiry: null }] });
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
      { generation: 'synthetic', id: 'q1', email: 'dead@x', projectId: 'p-exhausted', refreshToken: 'r', accessToken: 't', expiry: null },
      { generation: 'synthetic', id: 'q2', email: 'alive@x', projectId: 'p', refreshToken: 'r', accessToken: 't', expiry: null },
    ],
  });
  try {
    // q1 is selected first and answers 429: the same request moves on to q2
    const res = await post(stack.port, '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.choices[0].message.content, 'hey');
    // the bare 429 stays request-local: no shared account cooldown
    assert.deepEqual(stack.pool.healthy([{ generation: 'synthetic', id: 'q1' }, { generation: 'synthetic', id: 'q2' }]).map((a) => a.id), ['q1', 'q2']);
    const exhausted = await post(stack.port, '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'TRIGGER_429' }] });
    assert.equal(exhausted.status, 429);
  } finally {
    stack.server.close(); stack.upstreamServer.close();
  }
});

test('api key enforced when configured', async () => {
  const stack = await startStack({ accounts: [{ generation: 'synthetic', id: 'k1', projectId: 'p' }], apiKey: 'sk-secret' });
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
  const stack = await startStack({ accounts: [{ generation: 'synthetic', id: 'h1', email: 'e@x', projectId: 'p' }] });
  try {
    const health = await fetch(`http://127.0.0.1:${stack.port}/health`);
    const healthJson = await health.json();
    assert.equal(health.status, 200);
    assert.equal(healthJson.accounts[0].email, 'e@x');
    assert.equal(healthJson.liveness, 'ok');
    assert.equal(healthJson.eligibility.status, 'ok');
    assert.equal(healthJson.eligibility.restrictions.length, 0);
    assert.equal(healthJson.policyVersion, 'agy-rotator-1');
    // scoped state is operator-readable without exposing identity
    stack.pool.restrict({
      accountId: 'h1', scope: 'account_model', model: 'gemini-3.8-flash-high',
      until: Date.now() + 60_000, reason: 'scoped_quota', evidence: 'pool_gate',
    });
    const restricted = await (await fetch(`http://127.0.0.1:${stack.port}/health`)).json();
    assert.equal(restricted.liveness, 'ok', 'readable credentials remain live');
    assert.equal(restricted.eligibility.status, 'restricted');
    assert.equal(restricted.eligibility.restrictions[0].scope, 'account_model');
    assert.equal(restricted.eligibility.restrictions[0].resource, 'gemini-3.8-flash-high');
    assert.equal(JSON.stringify(restricted).includes('h1'), false);
    const models = await fetch(`http://127.0.0.1:${stack.port}/v1/models`);
    const modelsJson = await models.json();
    assert.ok(modelsJson.data.some((m) => m.id === 'gemini-3.8-flash-high'));
  } finally {
    stack.server.close(); stack.upstreamServer.close();
  }
});


test('native streamGenerateContent emits native SSE frames and no [DONE]', async () => {
  const stack = await startStack({ accounts: [{ generation: 'synthetic', id: 'ns1', email: 'a@x', projectId: 'p', refreshToken: 'r', accessToken: 't', expiry: null }] });
  try {
    const res = await post(stack.port, '/v1beta/models/gemini-3.8-flash:streamGenerateContent', {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /"candidates"/);
    assert.match(text, /"text":"he"/);
    assert.match(text, /"text":"y"/);
    assert.equal(text.includes('[DONE]'), false);
  } finally {
    stack.server.close(); stack.upstreamServer.close();
  }
});

test('403 TOS_VIOLATION parks the account and the turn moves to the next one', async () => {
  const stack = await startStack({
    accounts: [
      { generation: 'synthetic', id: 'tos1', email: 'banned@x', projectId: 'p-tos', refreshToken: 'r', accessToken: 't', expiry: null },
      { generation: 'synthetic', id: 'tos2', email: 'alive@x', projectId: 'p', refreshToken: 'r', accessToken: 't', expiry: null },
    ],
  });
  try {
    const res = await post(stack.port, '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.choices[0].message.content, 'hey');
    const health = await (await fetch(`http://127.0.0.1:${stack.port}/health`)).json();
    assert.equal(health.eligibility.status, 'restricted');
    const block = health.eligibility.restrictions.find((r) => r.scope === 'account');
    assert.ok(block, 'the TOS account is restricted');
    assert.equal(block.reason, 'account_restricted');
    assert.equal(block.until, null, 'a TOS block is permanent until the operator clears it');
    assert.equal(JSON.stringify(block).includes('banned@x'), false);
  } finally {
    stack.server.close(); stack.upstreamServer.close();
  }
});

test('/v1/quota exposes the warmup quota snapshot without identities', async () => {
  const stack = await startStack({ accounts: [{ generation: 'synthetic', id: 'qu1', email: 'q@x', projectId: 'p' }] });
  try {
    stack.upstreamClient.quotaByAccount.set('qu1', {
      at: '2026-11-16T00:00:00.000Z',
      summary: { buckets: [{ remainingFraction: 0.5, resetTime: '2026-11-16T05:00:00Z' }] },
    });
    const res = await fetch(`http://127.0.0.1:${stack.port}/v1/quota`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data.length, 1);
    assert.match(json.data[0].account, /^acct-/);
    assert.equal(json.data[0].summary.buckets[0].remainingFraction, 0.5);
    assert.equal(JSON.stringify(json).includes('q@x'), false);
  } finally {
    stack.server.close(); stack.upstreamServer.close();
  }
});
