// End-to-end handler behavior over real loopback HTTP and synthetic SSE/JSON upstreams. No real
// credential, provider call or external network is involved. These fixtures assert product behavior:
// bounded request-local rotation, scoped shared state, native/stream parity, safe metadata and
// operator-visible reasons.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { loadConfig } from '../src/config/load-config.js';
import { UpstreamClient, UpstreamError , generationOf} from '../src/upstream/upstream-client.js';
import { AccountPool } from '../src/upstream/account-pool.js';
import { createServer } from '../src/server/create-server.js';
import { accountLabel } from '../src/utils/alias.js';
import { EGRESS_COOLDOWN_MS } from '../src/upstream/rotation-policy.js';

const CONFIG = loadConfig({ env: { ANTIGRAVITY_PROXY_PORT: '0', ANTIGRAVITY_PROXY_LOG_LEVEL: 'error' } });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VALID_ID = '9f1c2d3e-4a5b-4c6d-8e7f-102132435465';
const STREAM_OK = [{ response: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] } }];
const TRUNCATED = [{ response: { candidates: [{ content: { parts: [{ text: 'partial' }] } }] } }];

const tokenFor = (account, version = 'v1') => `tok|${account.id}|${version}`;
const accountFromToken = (token) => String(token).split('|')[1] ?? 'unknown';

function recorder() {
  const events = [];
  const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((level) => [
    level, (event, data = {}) => events.push({ level, event, ...data }),
  ]));
  return { logger, events };
}

function responderBackend(responder, { projectFor = () => 'p' } = {}) {
  const calls = [];
  const projects = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.url.includes('loadCodeAssist')) {
        const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
        const accountId = accountFromToken(token);
        projects.push(accountId);
        const body = JSON.stringify({ cloudaicompanionProject: projectFor(accountId) });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
      const accountId = accountFromToken(token);
      const call = {
        accountId,
        token,
        path: req.url,
        body: raw ? JSON.parse(raw) : null,
        headers: req.headers,
      };
      calls.push(call);
      const out = responder(call, calls.length) ?? {};
      if (out.hang) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.flushHeaders?.();
        // Stay silent until the request deadline or the caller cancels; the test closes the server.
        res.on('error', () => {});
        return;
      }
      if (out.sse) {
        res.writeHead(out.status ?? 200, { 'content-type': 'text/event-stream', ...(out.headers ?? {}) });
        for (const frame of out.sse) res.write(`data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`);
        if (out.reset) {
          setTimeout(() => res.destroy(), 10);
          return;
        }
        res.end();
        return;
      }
      const body = JSON.stringify(out.json ?? {});
      res.writeHead(out.status ?? 200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...(out.headers ?? {}),
      });
      res.end(body);
    });
  });
  return { server, calls, projects };
}

async function startStack({
  accounts, responder, accessToken = null, rotation = {}, fallback = { enabled: false },
  egress = { url: null }, client: givenClient = null, projectFor = null,
}) {
  const backend = responderBackend(responder, projectFor ? { projectFor } : {});
  await once(backend.server.listen(0, '127.0.0.1'), 'listening');
  const { logger, events } = recorder();
  const config = {
    ...CONFIG,
    upstream: {
      ...CONFIG.upstream,
      baseUrl: `http://127.0.0.1:${backend.server.address().port}`,
      apiVersion: 'v1internal',
      requestTimeoutMs: 2_000,
      eagerRefreshMs: 0,
      egress,
    },
    rotation: {
      ...CONFIG.rotation,
      cooldownMs: 60_000,
      requestDeadlineMs: 5_000,
      ...rotation,
    },
    fallback: { enabled: false, ...fallback },
  };
  const client = givenClient ?? new UpstreamClient({ currentGeneration: generationOf, config, logger });
  if (!givenClient) client.accessToken = accessToken ?? (async (account) => tokenFor(account));
  const pool = new AccountPool({ logger });
  const store = { readAll: () => accounts.map((account) => ({ ...account })) };
  const server = createServer({ config, credentialStore: store, upstream: client, pool, logger });
  await once(server.listen(0, '127.0.0.1'), 'listening');
  const close = () => {
    server.closeAllConnections();
    server.close();
    backend.server.closeAllConnections();
    backend.server.close();
  };
  return {
    port: server.address().port,
    events,
    pool,
    client,
    config,
    store,
    calls: backend.calls,
    projects: backend.projects,
    close,
  };
}

async function chat(port, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

async function nativeGenerate(port, model = 'gemini-3.8-flash') {
  const res = await fetch(`http://127.0.0.1:${port}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'synthetic' }] }] }),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

function responseError(code, status, message = 'synthetic error') {
  return { error: { code, status, message } };
}

test('six unusable protocol outputs are bounded to two attempts, leave the pool untouched, and the next call works', async () => {
  const accounts = Array.from({ length: 6 }, (_, i) => ({
    id: `/creds/p${i}.json`, generation: `g${i}`, projectId: 'p', refreshToken: `r${i}`,
  }));
  let mode = 'truncated';
  const stack = await startStack({
    accounts,
    responder: () => (mode === 'truncated' ? { sse: TRUNCATED } : { sse: STREAM_OK }),
  });
  try {
    const first = await chat(stack.port, { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(first.status, 502);
    assert.equal(stack.calls.length, 2, 'one alternate account, not all six');
    assert.equal(first.headers.get('x-agy-attempts'), '2');
    assert.equal(first.headers.get('x-agy-reason'), 'protocol');
    assert.equal(stack.pool.snapshot().restricted, false, 'an unusable answer is not an account failure');
    const attempts = stack.events.filter((event) => event.event === 'attempt.timing');
    assert.deepEqual(attempts.map((entry) => entry.outcome), ['protocol', 'protocol']);
    assert.ok(attempts.every((entry) => entry.failureReason === 'truncated'));
    mode = 'ok';
    const second = await chat(stack.port, { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(second.status, 200);
    assert.equal(stack.pool.snapshot().restricted, false);
  } finally {
    stack.close();
  }
});

test('a generic 502 never becomes a fabricated 429 on a later request', async () => {
  const accounts = [
    { id: '/creds/a.json', generation: 'ga', projectId: 'p', refreshToken: 'ra' },
    { id: '/creds/b.json', generation: 'gb', projectId: 'p', refreshToken: 'rb' },
  ];
  let mode = '502';
  const stack = await startStack({
    accounts,
    responder: () => (mode === '502' ? { status: 502, json: responseError(502, 'UNAVAILABLE') } : { sse: STREAM_OK }),
  });
  try {
    const first = await chat(stack.port, { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(first.status, 502);
    assert.notEqual(first.status, 429);
    assert.equal(stack.pool.snapshot().restricted, false);
    mode = 'ok';
    const second = await chat(stack.port, { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(second.status, 200);
    assert.equal(stack.calls.at(-1).accountId, accounts[0].id, 'sticky-first is preserved');
  } finally {
    stack.close();
  }
});

test('a bare 429 rotates request-locally and is not remembered for the next request', async () => {
  const accounts = [
    { id: '/creds/a.json', generation: 'ga', projectId: 'p', refreshToken: 'ra' },
    { id: '/creds/b.json', generation: 'gb', projectId: 'p', refreshToken: 'rb' },
  ];
  const limited = new Set(['/creds/a.json']);
  const stack = await startStack({
    accounts,
    responder: (call) => (limited.has(call.accountId)
      ? { status: 429, json: responseError(429, 'RESOURCE_EXHAUSTED') }
      : { sse: STREAM_OK }),
  });
  try {
    const first = await chat(stack.port, { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(first.status, 200);
    assert.equal(stack.calls.map((call) => call.accountId).join(','), '/creds/a.json,/creds/b.json');
    assert.equal(stack.pool.snapshot().restricted, false, 'no account/model cooldown from an unscoped 429');
    limited.clear();
    const second = await chat(stack.port, { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(second.status, 200);
    assert.equal(stack.calls.at(-1).accountId, '/creds/a.json', 'the sticky account is tried again');
  } finally {
    stack.close();
  }
});

test('a real 429 mixed with a blocked credential is a service failure, not a fabricated quota answer', async () => {
  const accounts = [
    { id: '/creds/a.json', generation: 'ga', projectId: 'p', refreshToken: 'ra' },
    { id: '/creds/b.json', generation: 'gb', projectId: 'p', refreshToken: 'rb' },
  ];
  const stack = await startStack({
    accounts,
    responder: (call) => (call.accountId === accounts[0].id
      ? { status: 429, json: responseError(429, 'RESOURCE_EXHAUSTED') }
      : { sse: STREAM_OK }),
  });
  try {
    stack.pool.blockGeneration({
      accountId: accounts[1].id, generation: 'gb', reason: 'revoked_credential', evidence: 'oauth_invalid_grant',
    });
    const res = await chat(stack.port, { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(res.status, 503, 'the pool was not exhausted by quota alone');
    assert.notEqual(res.status, 429);
    assert.equal(res.headers.get('x-agy-reason'), 'transient');
  } finally {
    stack.close();
  }
});

test('an exact invalid_grant blocks only that material generation and a replacement is selectable again', async () => {
  const accounts = [
    { id: '/creds/a.json', generation: 'g1', projectId: 'p', refreshToken: 'refresh-a1' },
    { id: '/creds/b.json', generation: 'gb', projectId: 'p', refreshToken: 'refresh-b' },
  ];
  let revoked = true;
  const accessToken = async (account) => {
    if (account.id === accounts[0].id && revoked) {
      throw new UpstreamError('oauth refresh rejected: credential revoked', {
        origin: 'oauth', phase: 'refresh', reason: 'revoked_credential', scope: 'credential',
        evidence: 'oauth_invalid_grant', publicStatus: 502, accountId: account.id, generation: account.generation,
      });
    }
    return tokenFor(account);
  };
  const stack = await startStack({
    accounts, accessToken, responder: () => ({ sse: STREAM_OK }),
  });
  try {
    const first = await chat(stack.port, { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(first.status, 200);
    assert.deepEqual(stack.calls.map((call) => call.accountId), ['/creds/b.json']);
    let snapshot = stack.pool.snapshot(accounts);
    assert.equal(snapshot.credentialBlocks.length, 1);
    assert.equal(snapshot.credentialBlocks[0].reason, 'revoked_credential');

    const second = await chat(stack.port, { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(second.status, 200);
    assert.equal(stack.calls.at(-1).accountId, '/creds/b.json', 'the revoked generation stays blocked without a timer');

    // A re-login replaces the refresh token at the same path: new material, new selectability.
    revoked = false;
    accounts[0] = { ...accounts[0], generation: 'g2', refreshToken: 'refresh-a2' };
    const third = await chat(stack.port, { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(third.status, 200);
    assert.equal(stack.calls.at(-1).accountId, '/creds/a.json');
    snapshot = stack.pool.snapshot(accounts);
    assert.equal(snapshot.credentialBlocks.length, 0, 'a stale block for old material is not reported');
  } finally {
    stack.close();
  }
});

test('OAuth network/5xx/malformed failures alternate without blocking the credential generation', async () => {
  const accounts = [
    { id: '/creds/a.json', generation: 'g1', projectId: 'p', refreshToken: 'refresh-a' },
    { id: '/creds/b.json', generation: 'gb', projectId: 'p', refreshToken: 'refresh-b' },
  ];
  let broken = true;
  const accessToken = async (account) => {
    if (account.id === accounts[0].id && broken) {
      throw new UpstreamError('oauth token endpoint unavailable', {
        origin: 'oauth', phase: 'refresh', reason: 'oauth_unavailable', scope: 'unknown',
        evidence: 'oauth_network', publicStatus: 502, accountId: account.id, generation: account.generation,
        retryable: true,
      });
    }
    return tokenFor(account);
  };
  const stack = await startStack({ accounts, accessToken, responder: () => ({ sse: STREAM_OK }) });
  try {
    const first = await chat(stack.port, { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(first.status, 200);
    assert.equal(stack.pool.snapshot(accounts).credentialBlocks.length, 0, 'a transient refresh is not revocation');
    broken = false;
    const second = await chat(stack.port, { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(second.status, 200);
    assert.equal(stack.calls.at(-1).accountId, '/creds/a.json');
  } finally {
    stack.close();
  }
});

test('one generation 401 forces exactly one refresh and then succeeds on the same credential', async () => {
  const account = { id: '/creds/a.json', generation: 'g1', projectId: 'p', refreshToken: 'refresh-a' };
  let tokenCalls = 0;
  const accessToken = async (current) => tokenFor(current, tokenCalls++ === 0 ? 'old' : 'new');
  const stack = await startStack({
    accounts: [account],
    accessToken,
    responder: (call) => (call.token.endsWith('|old')
      ? { status: 401, json: responseError(401, 'UNAUTHENTICATED') }
      : { sse: STREAM_OK }),
  });
  try {
    const res = await chat(stack.port, { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(res.status, 200);
    assert.equal(stack.calls.length, 2, 'one original POST and one forced-auth retry');
    assert.equal(res.headers.get('x-agy-attempts'), '2');
    const attempts = stack.events.filter((event) => event.event === 'attempt.timing');
    assert.deepEqual(attempts.map((entry) => entry.outcome), ['auth_retry', 'ok']);
    assert.equal(stack.pool.snapshot().credentialBlocks.length, 0, 'a 401 is not a revoked credential');
  } finally {
    stack.close();
  }
});

test('a repeated 401 after refresh stops this credential locally without revocation', async () => {
  const account = { id: '/creds/a.json', generation: 'g1', projectId: 'p', refreshToken: 'refresh-a' };
  let tokenCalls = 0;
  const accessToken = async (current) => tokenFor(current, tokenCalls++ === 0 ? 'old' : 'new');
  const stack = await startStack({
    accounts: [account],
    accessToken,
    responder: () => ({ status: 401, json: responseError(401, 'UNAUTHENTICATED') }),
  });
  try {
    const res = await chat(stack.port, { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(res.status, 502);
    assert.notEqual(res.status, 401, 'upstream credential failure is not the caller API-key error');
    assert.equal(res.headers.get('x-agy-reason'), 'auth');
    assert.equal(stack.calls.length, 2);
    const attempts = stack.events.filter((event) => event.event === 'attempt.timing');
    assert.deepEqual(attempts.map((entry) => entry.outcome), ['auth_retry', 'auth']);
    assert.equal(attempts[1].failureReason, 'auth_rejected');
    assert.equal(attempts[1].decisionReason, 'auth_rejected_after_refresh', 'the policy records the request-local stop reason');
    assert.equal(stack.pool.snapshot().credentialBlocks.length, 0);
  } finally {
    stack.close();
  }
});

test('the native generateContent lane rejects embedded errors and missing terminals, and preserves refusals', async () => {
  const account = { id: '/creds/a.json', generation: 'ga', projectId: 'p', refreshToken: 'ra' };
  let mode = 'embedded429';
  const stack = await startStack({
    accounts: [account],
    responder: (call) => {
      if (call.path.includes('streamGenerateContent')) return { sse: STREAM_OK };
      if (mode === 'embedded429') return { status: 200, json: responseError(429, 'RESOURCE_EXHAUSTED') };
      if (mode === 'noTerminal') return { status: 200, json: { response: { candidates: [{ content: { parts: [{ text: 'unfinished' }] } }] } } };
      if (mode === 'refusal') return { status: 200, json: { response: { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } } } };
      if (mode === 'maxTokens') return { status: 200, json: { response: { candidates: [{ content: { parts: [{ text: 'cut' }] }, finishReason: 'MAX_TOKENS' }] } } };
      return { status: 200, json: { response: { candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] } } };
    },
  });
  try {
    const embedded = await nativeGenerate(stack.port);
    assert.equal(embedded.status, 429, 'an embedded quota error is not a fabricated 200');
    assert.equal(embedded.headers.get('x-agy-reason'), 'quota');
    assert.equal(stack.events.find((event) => event.event === 'attempt.timing').observedStatus, 200);

    mode = 'noTerminal';
    const missing = await nativeGenerate(stack.port);
    assert.equal(missing.status, 502);
    assert.equal(missing.headers.get('x-agy-reason'), 'protocol');

    mode = 'refusal';
    const refusal = await nativeGenerate(stack.port);
    assert.equal(refusal.status, 200);
    assert.equal(JSON.parse(refusal.text).promptFeedback.blockReason, 'PROHIBITED_CONTENT');

    mode = 'maxTokens';
    const cut = await nativeGenerate(stack.port);
    assert.equal(cut.status, 200);
    assert.equal(JSON.parse(cut.text).candidates[0].finishReason, 'MAX_TOKENS');

    mode = 'stop';
    const stop = await nativeGenerate(stack.port);
    assert.equal(stop.status, 200);
    assert.equal(JSON.parse(stop.text).candidates[0].finishReason, 'STOP');
    assert.equal(stop.headers.get('x-agy-route'), 'agy');
    assert.match(stop.headers.get('x-agy-request-id'), UUID_RE);
  } finally {
    stack.close();
  }
});

test('a pre-header stream failure rotates and the SSE header reports the attempts known at commit', async () => {
  const accounts = [
    { id: '/creds/a.json', generation: 'ga', projectId: 'p', refreshToken: 'ra' },
    { id: '/creds/b.json', generation: 'gb', projectId: 'p', refreshToken: 'rb' },
  ];
  const stack = await startStack({
    accounts,
    responder: (call) => (call.accountId === accounts[0].id
      ? { status: 502, json: responseError(502, 'UNAVAILABLE') }
      : { sse: STREAM_OK }),
  });
  try {
    const res = await chat(stack.port, { model: 'gemini-3.8-flash-high', stream: true, messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(res.status, 200);
    assert.match(res.text, /"content":"ok"/);
    assert.equal(res.headers.get('x-agy-attempts'), '2', 'headers are written only when the second stream commits');
    assert.equal(stack.calls.length, 2);
    assert.equal(stack.events.find((event) => event.event === 'request.timing').route, 'agy');
  } finally {
    stack.close();
  }
});

test('a committed client stream never rotates, but it still classifies the observed 429', async () => {
  const account = { id: '/creds/a.json', generation: 'ga', projectId: 'p', refreshToken: 'ra' };
  const stack = await startStack({
    accounts: [account],
    responder: () => ({
      sse: [
        { response: { candidates: [{ content: { parts: [{ text: 'partial' }] } }] } },
        responseError(429, 'RESOURCE_EXHAUSTED'),
      ],
    }),
  });
  try {
    const res = await chat(stack.port, { model: 'gemini-3.8-flash-high', stream: true, messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(res.status, 200, 'the stream had already committed');
    assert.match(res.text, /"content":"partial"/);
    assert.match(res.text, /upstream stream failed/);
    assert.match(res.text, /\[DONE\]/);
    assert.equal(stack.calls.length, 1, 'no second account feeds a started stream');
    assert.equal(res.headers.get('x-agy-attempts'), '1');
    assert.equal(stack.pool.snapshot().restricted, false, 'a bare 429 is never widened to shared state');
    const attempt = stack.events.find((event) => event.event === 'attempt.timing');
    assert.equal(attempt.outcome, 'stream_failed');
    assert.equal(attempt.failureReason, 'rate_limit_unknown_scope');
    assert.equal(attempt.decision, 'stop');
    assert.equal(attempt.stopReason, 'headers_committed');
    assert.equal(attempt.retry, false);
  } finally {
    stack.close();
  }
});

test('response metadata and journals correlate one strict UUID and expose no payload or identity', async () => {
  const account = {
    id: '/home/SENTINEL/.config/creds/SENTINEL_TOKEN_FILE.json',
    generation: 'SENTINEL_GENERATION',
    projectId: 'SENTINEL_PROJECT_ID',
    refreshToken: 'SENTINEL_REFRESH_TOKEN',
  };
  let mode = 'ok';
  const stack = await startStack({
    accounts: [account],
    responder: () => (mode === 'ok'
      ? { sse: STREAM_OK }
      : { status: 500, json: { error: { code: 500, status: 'INTERNAL', message: 'SENTINEL_UPSTREAM_BODY' } } }),
  });
  try {
    const success = await chat(
      stack.port,
      { model: 'SENTINEL_ARBITRARY_MODEL', messages: [{ role: 'user', content: 'SENTINEL_PROMPT' }] },
      { 'x-request-id': VALID_ID },
    );
    assert.equal(success.status, 200);
    assert.equal(success.headers.get('x-agy-request-id'), VALID_ID);
    assert.equal(success.headers.get('x-agy-route'), 'agy');
    assert.equal(success.headers.get('x-agy-attempts'), '1');
    assert.equal(success.headers.get('x-agy-policy'), 'agy-rotator-1');

    const junk = await chat(
      stack.port,
      { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hello' }] },
      { 'x-request-id': 'SENTINEL_ARBITRARY_CALLER_ID' },
    );
    assert.equal(junk.status, 200);
    assert.match(junk.headers.get('x-agy-request-id'), UUID_RE);
    assert.notEqual(junk.headers.get('x-agy-request-id'), 'SENTINEL_ARBITRARY_CALLER_ID');

    mode = 'error';
    const failure = await chat(stack.port, { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(failure.status, 502);
    assert.equal(failure.headers.get('x-agy-reason'), 'transient');
    assert.match(failure.headers.get('x-agy-request-id'), UUID_RE);
    assert.match(failure.text, /ref [0-9a-f-]{36}/);

    const text = JSON.stringify(stack.events);
    for (const secret of ['SENTINEL_PROMPT', 'SENTINEL_UPSTREAM_BODY', 'SENTINEL_PROJECT_ID',
      'SENTINEL_TOKEN_FILE', 'SENTINEL_GENERATION', 'SENTINEL_REFRESH_TOKEN',
      'SENTINEL_ARBITRARY_MODEL', 'SENTINEL_ARBITRARY_CALLER_ID', '/home/SENTINEL']) {
      assert.equal(text.includes(secret), false, `journal leaked ${secret}`);
      assert.equal(failure.text.includes(secret), false, `client error leaked ${secret}`);
    }
    const requestLines = stack.events.filter((event) => event.event === 'request.timing');
    assert.equal(requestLines.length, 3);
    assert.ok(requestLines.every((line) => UUID_RE.test(line.requestId)));
    const attempts = stack.events.filter((event) => event.event === 'attempt.timing');
    assert.ok(attempts.every((line) => typeof line.attempt === 'number'));
    assert.ok(attempts.every((line) => line.policyVersion === 'agy-rotator-1'));
    assert.equal(attempts[0].modelRequested, 'unknown', 'junk caller model text is not journaled');
    assert.equal(attempts[1].modelRequested, 'gemini-3.8-flash-high');
    assert.equal(attempts[1].modelOutbound, 'gemini-3.8-flash-high');
    assert.equal(attempts[1].modelReported, null);
    assert.equal(attempts[1].account, accountLabel(account));

    // Requested, outbound (after effort/catalog transform) and provider-reported stay separate.
    mode = 'ok';
    const effort = await chat(stack.port, {
      model: 'gemini-3.8-flash-low',
      reasoning_effort: 'high',
      messages: [{ role: 'user', content: 'hello' }],
    });
    assert.equal(effort.status, 200);
    const transformed = stack.events.filter((event) => event.event === 'attempt.timing').at(-1);
    assert.equal(transformed.modelRequested, 'gemini-3.8-flash-low');
    assert.equal(transformed.modelOutbound, 'gemini-3.8-flash-high');
    assert.equal(transformed.modelReported, null, 'an echoed request label is never proof of the served model');
  } finally {
    stack.close();
  }
});

test('pool exhaustion describes the actual reason: quota 429 with Retry-After, blocked/egress 503, mixed 502', async () => {
  const account = { id: '/creds/a.json', generation: 'ga', projectId: 'p', refreshToken: 'ra' };
  const quotaStack = await startStack({ accounts: [account], responder: () => ({ sse: STREAM_OK }) });
  try {
    quotaStack.pool.restrict({
      accountId: account.id, scope: 'account', until: Date.now() + 60_000,
      reason: 'account_restricted', evidence: 'pool_gate',
    });
    const quota = await chat(quotaStack.port, { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(quota.status, 429);
    assert.ok(Number(quota.headers.get('retry-after')) > 0, 'the gate proves the real eligibility time');
    assert.equal(quota.headers.get('x-agy-reason'), 'quota');
    assert.equal(quotaStack.calls.length, 0, 'a gated account is never dispatched');
  } finally {
    quotaStack.close();
  }

  const blockedStack = await startStack({ accounts: [account], responder: () => ({ sse: STREAM_OK }) });
  try {
    blockedStack.pool.blockGeneration({
      accountId: account.id, generation: 'ga', reason: 'revoked_credential', evidence: 'oauth_invalid_grant',
    });
    const blocked = await chat(blockedStack.port, { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(blocked.status, 503);
    assert.equal(blocked.headers.get('x-agy-reason'), 'credential_blocked');
    assert.notEqual(blocked.status, 429, 'a blocked credential is not a quota 429');
  } finally {
    blockedStack.close();
  }

  const egressAccount = { id: '/creds/e.json', generation: 'ge', projectId: 'p', refreshToken: 're' };
  const egressUrl = 'socks5://alice:SENTINEL_PROXY_SECRET@proxy.example:1080';
  const egressStack = await startStack({
    accounts: [egressAccount],
    egress: { url: null, accounts: { 'e.json': egressUrl } },
    responder: () => ({ sse: STREAM_OK }),
  });
  try {
    egressStack.pool.restrict({
      scope: 'egress', egressKey: egressUrl, egressAlias: 'egress-aaaaaaaa',
      until: Date.now() + EGRESS_COOLDOWN_MS, reason: 'egress_unavailable', evidence: 'egress_connect',
    });
    const egress = await chat(egressStack.port, { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(egress.status, 503);
    assert.equal(egress.headers.get('x-agy-reason'), 'egress');
    assert.equal(egressStack.calls.length, 0);
    assert.equal(JSON.stringify(egressStack.pool.snapshot()).includes('SENTINEL_PROXY_SECRET'), false);
  } finally {
    egressStack.close();
  }

  const mixedAccounts = [
    { id: '/creds/x.json', generation: 'gx', projectId: 'p', refreshToken: 'rx' },
    { id: '/creds/y.json', generation: 'gy', projectId: 'p', refreshToken: 'ry' },
  ];
  const mixedStack = await startStack({
    accounts: mixedAccounts,
    responder: (call) => (call.accountId === mixedAccounts[0].id
      ? { status: 502, json: responseError(502, 'UNAVAILABLE') }
      : { sse: STREAM_OK }),
  });
  try {
    mixedStack.pool.restrict({
      accountId: mixedAccounts[1].id, scope: 'account', until: Date.now() + 60_000,
      reason: 'account_restricted', evidence: 'pool_gate',
    });
    const mixed = await chat(mixedStack.port, { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(mixed.status, 502, 'a real prior failure beats a synthesized pool status');
    assert.notEqual(mixed.status, 429);
  } finally {
    mixedStack.close();
  }
});

test('an expired scope admits one real probe, a concurrent caller sees probe_busy, and cancellation releases it', async () => {
  const account = { id: '/creds/a.json', generation: 'ga', projectId: 'p', refreshToken: 'ra' };
  let mode = 'hang';
  const stack = await startStack({
    accounts: [account],
    responder: () => (mode === 'hang' ? { hang: true } : { sse: STREAM_OK }),
  });
  try {
    stack.pool.restrict({
      accountId: account.id, scope: 'account', until: Date.now() - 1,
      reason: 'account_restricted', evidence: 'pool_gate',
    });
    const body = JSON.stringify({ model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hello' }] });
    const first = http.request({
      host: '127.0.0.1', port: stack.port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => res.resume());
    first.on('error', () => {});
    first.end(body);
    const startedAt = Date.now();
    while (stack.calls.length === 0 && Date.now() - startedAt < 2_000) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(stack.calls.length, 1, 'the probe reached the wire');
    assert.equal(stack.pool.snapshot().activeProbes.length, 1);

    const busy = await chat(stack.port, { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get('x-agy-reason'), 'resource_gated');
    assert.equal(stack.calls.length, 1, 'no second probe while the first attempt is live');

    first.destroy();
    const leftAt = Date.now();
    while (!stack.events.some((event) => event.event === 'attempt.timing' && event.outcome === 'client_abort')
      && Date.now() - leftAt < 2_000) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(stack.pool.snapshot().activeProbes.length, 0, 'cancellation released the probe lease');
    assert.equal(stack.pool.snapshot().restrictions[0].state, 'expired_probe_eligible', 'cancellation is not recovery');

    mode = 'ok';
    const recovered = await chat(stack.port, { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(recovered.status, 200);
    assert.equal(stack.pool.snapshot().restricted, false, 'a real success recovered the scope');
  } finally {
    stack.close();
  }
});

test('a proven egress failure gates that egress only and the next request skips only that account', async () => {
  const accounts = [
    { id: '/creds/a.json', generation: 'ga', projectId: 'p', refreshToken: 'ra' },
    { id: '/creds/b.json', generation: 'gb', projectId: 'p', refreshToken: 'rb' },
  ];
  const egressKeys = {
    '/creds/a.json': { key: 'socks5://alice:secret@proxy:1080', alias: 'egress-aaaa1111' },
    '/creds/b.json': { key: 'socks5://bob:other@proxy:1080', alias: 'egress-bbbb2222' },
  };
  let failA = true;
  const client = {
    egressIdentityFor: (account) => egressKeys[account.id],
    invalidate() {},
    forceRefresh() {},
    async generateStream({ account }) {
      if (account.id === '/creds/a.json' && failA) {
        throw new UpstreamError('egress is unavailable', {
          origin: 'egress', phase: 'connect', reason: 'egress_unavailable', scope: 'egress',
          evidence: 'egress_connect', publicStatus: 502,
          egressKey: egressKeys[account.id].key, egressAlias: egressKeys[account.id].alias,
          accountId: account.id, generation: account.generation,
        });
      }
      return new Response(`data: ${JSON.stringify(STREAM_OK[0])}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    },
  };
  const stack = await startStack({ accounts, client, responder: () => ({ sse: STREAM_OK }) });
  try {
    const first = await chat(stack.port, { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(first.status, 200);
    const snapshot = stack.pool.snapshot(accounts);
    assert.equal(snapshot.restrictions.length, 1);
    assert.equal(snapshot.restrictions[0].scope, 'egress');
    assert.equal(snapshot.restrictions[0].resource, 'egress-aaaa1111');
    assert.equal(JSON.stringify(snapshot).includes('alice'), false);
    assert.equal(first.headers.get('x-agy-attempts'), '2');
    failA = false;
    const second = await chat(stack.port, { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('x-agy-attempts'), '1', 'the egress-gated account was skipped');
    assert.equal(stack.pool.snapshot(accounts).restrictions[0].scope, 'egress', 'a success on another egress does not erase it');
  } finally {
    stack.close();
  }
});

test('mixed 401/502/protocol failures keep the dispatch bound and per-credential allowance', async () => {
  const accounts = Array.from({ length: 3 }, (_, i) => ({
    id: `/creds/m${i}.json`, generation: `gm${i}`, projectId: 'p', refreshToken: `rm${i}`,
  }));
  let tokenSequence = 0;
  const accessToken = async (account) => {
    // Only the first account gets a fresh token after its forced refresh.
    if (account.id === accounts[0].id) return tokenFor(account, tokenSequence++ === 0 ? 'old' : 'new');
    return tokenFor(account);
  };
  const stack = await startStack({
    accounts,
    accessToken,
    responder: (call) => {
      if (call.accountId === accounts[0].id) {
        return call.token.endsWith('|old')
          ? { status: 401, json: responseError(401, 'UNAUTHENTICATED') }
          : { status: 502, json: responseError(502, 'UNAVAILABLE') };
      }
      return { sse: TRUNCATED };
    },
  });
  try {
    const res = await chat(stack.port, { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hello' }] });
    assert.notEqual(res.status, 200);
    const maxGeneration = 2 * accounts.length;
    assert.ok(stack.calls.length <= maxGeneration, `generation POSTs ${stack.calls.length} <= 2N ${maxGeneration}`);
    const perAccount = new Map();
    for (const call of stack.calls) perAccount.set(call.accountId, (perAccount.get(call.accountId) ?? 0) + 1);
    for (const count of perAccount.values()) assert.ok(count <= 2, 'per-credential generation POSTs');
    const requestLine = stack.events.find((event) => event.event === 'request.timing');
    assert.ok(requestLine.generationPosts <= maxGeneration);
    assert.equal(requestLine.generationPosts, stack.calls.length);
    assert.equal(requestLine.oauthPosts, 0, 'the synthetic accessToken stub performs no physical OAuth POST');
    assert.equal(requestLine.projectPosts, 0, 'credential files already carry the project');
  } finally {
    stack.close();
  }
});


test('a post-dispatch body reset stays an uncertain failure and writes no shared state', async () => {
  const account = { id: '/creds/a.json', generation: 'ga', projectId: 'p', refreshToken: 'ra' };
  const stack = await startStack({
    accounts: [account],
    responder: () => ({
      sse: [{ response: { candidates: [{ content: { parts: [{ text: 'partial' }] } }] } }],
      reset: true,
    }),
  });
  try {
    const res = await chat(stack.port, { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(res.status, 502);
    assert.equal(stack.pool.snapshot().restricted, false, 'a reset after dispatch does not prove a bad account');
    const attempt = stack.events.find((event) => event.event === 'attempt.timing');
    assert.equal(attempt.sharedEffect, 'none');
    assert.equal(attempt.failureScope, 'unknown');
  } finally {
    stack.close();
  }
});

test('a project gate is rechecked after asynchronous project resolution, before any generation dispatch', async () => {
  const account = { id: '/creds/a.json', generation: 'ga', refreshToken: 'ra' };
  const stack = await startStack({
    accounts: [account],
    projectFor: () => 'shared-project',
    responder: () => ({ sse: STREAM_OK }),
  });
  try {
    stack.pool.restrict({
      projectId: 'shared-project', scope: 'project', until: Date.now() + 60_000,
      reason: 'project_restricted', evidence: 'pool_gate',
    });
    const res = await chat(stack.port, { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('x-agy-reason'), 'resource_gated');
    assert.equal(stack.projects.length, 1, 'the project was resolved');
    assert.equal(stack.calls.length, 0, 'no generation POST reached the wire');
    assert.equal(res.headers.get('x-agy-attempts'), '1');
  } finally {
    stack.close();
  }
});


test('a local request-shape rejection is a caller 400, never an upstream failure or shared penalty', async () => {
  const account = { id: '/creds/a.json', generation: 'ga', projectId: 'p', refreshToken: 'ra' };
  const stack = await startStack({ accounts: [account], responder: () => ({ sse: STREAM_OK }) });
  try {
    const recursive = {
      type: 'object',
      properties: { node: { $ref: '#/$defs/node' } },
      $defs: { node: { $ref: '#/$defs/node' } },
    };
    const res = await chat(stack.port, {
      model: 'gemini-3.8-flash-high',
      response_format: { type: 'json_schema', json_schema: { name: 's', strict: true, schema: recursive } },
      messages: [{ role: 'user', content: 'hello' }],
    });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('x-agy-reason'), 'invalid_request');
    assert.equal(stack.calls.length, 0, 'the request never reached the upstream');
    assert.equal(stack.pool.snapshot().restricted, false, 'caller input is not account health evidence');
    assert.equal(res.headers.get('x-agy-attempts'), '1', 'one logical attempt, zero wire dispatches');
    assert.equal(stack.events.find((event) => event.event === 'request.timing').generationPosts, 0);
  } finally {
    stack.close();
  }
});


test('committed SSE errors never echo arbitrary uppercase terminal values', async () => {
  const stack = await startStack({
    accounts: [{ id: '/creds/a.json', generation: 'ga', projectId: 'p' }],
    responder: () => ({ sse: [{ response: { candidates: [{ finishReason: 'SENTINEL_PRIVATE_TERMINAL' }] } }] }),
  });
  try {
    const response = await chat(stack.port, { model: 'gemini-3.8-flash-high', stream: true, messages: [{ role: 'user', content: 'synthetic' }] });
    assert.equal(response.text.includes('SENTINEL_PRIVATE_TERMINAL'), false);
  } finally { stack.close(); }
});

test('material replacement during preparation retries the actual new credential snapshot', async () => {
  const accounts = [{ id: '/creds/a.json', generation: 'g1', projectId: 'p', refreshToken: 'r1' }];
  let calls = 0;
  const stack = await startStack({
    accounts,
    accessToken: async (account) => {
      if (++calls === 1) accounts.splice(0, 1, { ...account, generation: 'g2', refreshToken: 'r2' });
      return tokenFor(account, account.generation);
    },
    responder: () => ({ sse: STREAM_OK }),
  });
  try {
    const response = await chat(stack.port, { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'synthetic' }] });
    assert.equal(response.status, 200);
    assert.equal(stack.calls.length, 1);
    assert.ok(stack.calls[0].token.endsWith('|g2'));
  } finally { stack.close(); }
});
