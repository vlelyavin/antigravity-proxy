// Credential generation, token/project cache ownership and physical dispatch bounds. Synthetic
// token endpoints and loopback stubs only; no real credential or network call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UpstreamClient, UpstreamError , generationOf} from '../src/upstream/upstream-client.js';
import { createDispatchBudget } from '../src/upstream/dispatch-budget.js';
import { CredentialStore, materialGeneration } from '../src/credentials/credential-store.js';
import { EgressError } from '../src/upstream/egress.js';

const logger = { info() {}, warn() {}, error() {} };
const CONFIG = {
  upstream: {
    baseUrl: 'http://127.0.0.1:1',
    apiVersion: 'v1internal',
    userAgent: 'synthetic',
    requestTimeoutMs: 2_000,
    eagerRefreshMs: 0,
    egress: { url: null },
  },
};

function client(config = CONFIG) {
  return new UpstreamClient({ currentGeneration: generationOf, config, logger });
}

function account(generation, refreshToken = `refresh-${generation}`) {
  return { id: '/creds/a.json', generation, refreshToken, projectId: 'p' };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tokenResponse = (token, expiresIn = 3600) => ({
  ok: true, status: 200, json: async () => ({ access_token: token, expires_in: expiresIn }),
});

test('a cached access token is generation-scoped: replacing material refreshes at the same path', async () => {
  const upstream = client();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return tokenResponse(`token-${calls}`);
  };
  const g1 = account('g1', 'refresh-one');
  const g2 = { ...g1, generation: 'g2', refreshToken: 'refresh-two' };
  assert.equal(await upstream.accessToken(g1, { fetchImpl }), 'token-1');
  assert.equal(await upstream.accessToken(g1, { fetchImpl }), 'token-1', 'same generation reuses the cache');
  assert.equal(await upstream.accessToken(g2, { fetchImpl }), 'token-2', 'new material never reuses the old token');
  assert.equal(calls, 2);
  assert.equal(upstream.tokens.get(g1.id).generation, 'g2');
});

test('a normal access-token refresh is a new token version, not a material replacement', async () => {
  const config = { upstream: { ...CONFIG.upstream, eagerRefreshMs: 24 * 3600 * 1000 } };
  const upstream = client(config);
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return tokenResponse(`token-${calls}`); };
  const g1 = account('g1');
  assert.equal(await upstream.accessToken(g1, { fetchImpl }), 'token-1');
  assert.equal(await upstream.accessToken(g1, { fetchImpl }), 'token-2', 'eager window forces a refresh');
  assert.equal(upstream.tokens.get(g1.id).generation, 'g1');
  assert.equal(upstream.tokens.get(g1.id).version, 2);
  assert.equal(calls, 2);
});

test('a late old-generation failure leaves the newer cached token untouched', async () => {
  const upstream = client();
  upstream.tokens.set('/creds/a.json', {
    token: 'token-g2', expiresAt: Date.now() + 60_000, generation: 'g2', version: 7, cachedAt: Date.now(),
  });
  const g1 = account('g1');
  await assert.rejects(
    upstream.accessToken(g1, { fetchImpl: async () => { throw new Error('synthetic network failure'); } }),
    (error) => error instanceof UpstreamError && error.reason === 'oauth_unavailable',
  );
  assert.equal(upstream.tokens.get('/creds/a.json').token, 'token-g2');
  assert.equal(upstream.invalidate(g1), false, 'a stale generation cannot invalidate a newer token');
  // invalidate is generation-checked too
  assert.equal(upstream.tokens.get('/creds/a.json').token, 'token-g2');
  upstream.invalidate(g1, { generation: 'g2' });
  assert.equal(upstream.tokens.has('/creds/a.json'), false);
});

test('a stale g1 refresh cannot overwrite a newer g2 token, and a replaced credential is rejected', async () => {
  const upstream = client();
  const started = deferred();
  const gate = deferred();
  const g1 = account('g1');
  const pending = upstream.accessToken(g1, {
    fetchImpl: async () => { started.resolve(); return gate.promise; },
  });
  await started.promise;
  // New material at the same path wins the cache while g1 is still in flight.
  upstream.tokens.set('/creds/a.json', {
    token: 'token-g2', expiresAt: Date.now() + 60_000, generation: 'g2', version: 9, cachedAt: Date.now(),
  });
  g1.generation = 'g2';
  g1.refreshToken = 'refresh-two';
  gate.resolve(tokenResponse('token-g1'));
  await assert.rejects(pending, (error) => error instanceof UpstreamError && error.reason === 'credential_replaced');
  assert.equal(upstream.tokens.get('/creds/a.json').token, 'token-g2');
});

test('stale refresh cleanup never deletes a newer in-flight entry', async () => {
  const upstream = client();
  const fetches = { g1: deferred() };
  const calls = [];
  const fetchImpl = (url, options) => {
    const body = String(options.body);
    const generation = body.includes('refresh-g1') ? 'g1' : 'g2';
    calls.push(generation);
    return fetches[generation]?.promise ?? fetches[generation].promise;
  };
  const g1 = account('g1');
  const g2 = account('g2');
  fetches.g2 = deferred();
  const p1 = upstream.accessToken(g1, { fetchImpl });
  const p2 = upstream.accessToken(g2, { fetchImpl });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.sort(), ['g1', 'g2']);
  assert.equal(upstream.refreshing.size, 2);
  fetches.g2.resolve(tokenResponse('token-g2'));
  assert.equal(await p2, 'token-g2');
  assert.equal(upstream.refreshing.size, 1, 'the g1 entry is still owned by its own promise');
  fetches.g1.resolve(tokenResponse('token-g1'));
  assert.equal(await p1, 'token-g1');
  assert.equal(upstream.refreshing.size, 0);
  assert.equal(upstream.tokens.get('/creds/a.json').token, 'token-g2', 'the late g1 result did not replace g2');
});

test('concurrent callers join one shared refresh; the join is not a physical OAuth POST', async () => {
  const upstream = client();
  const budget = createDispatchBudget({ credentials: 1 });
  const gate = deferred();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; await gate.promise; return tokenResponse('joined-token'); };
  const g1 = account('g1');
  const first = upstream.accessToken(g1, { fetchImpl, budget });
  const second = upstream.accessToken(g1, { fetchImpl, budget });
  await new Promise((resolve) => setImmediate(resolve));
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), ['joined-token', 'joined-token']);
  assert.equal(calls, 1);
  assert.equal(budget.counts().oauth, 1);
  assert.equal(budget.counts().refreshJoins, 1);
});

test('the project cache is generation-scoped', async () => {
  const upstream = client();
  upstream.accessToken = async () => 'token';
  let probes = 0;
  upstream.request = async () => {
    probes += 1;
    return { ok: true, json: async () => ({ cloudaicompanionProject: `project-${probes}` }) };
  };
  const g1 = { id: '/creds/a.json', generation: 'g1' };
  assert.equal(await upstream.ensureProject(g1), 'project-1');
  assert.equal(await upstream.ensureProject({ id: '/creds/a.json', generation: 'g1' }), 'project-1');
  assert.equal(probes, 1, 'same generation reuses the cached project');
  assert.equal(await upstream.ensureProject({ id: '/creds/a.json', generation: 'g2' }), 'project-2');
  assert.equal(probes, 2, 'new material probes again');
});

test('the lastGood credential snapshot keeps its material generation', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-generation-'));
  const file = path.join(dir, 'cred.json');
  try {
    await fs.writeFile(file, JSON.stringify({ access_token: 'a', refresh_token: 'refresh-last-good' }));
    const store = new CredentialStore({ searchPaths: [file], logger });
    const first = store.readAll()[0];
    assert.equal(first.generation, materialGeneration('refresh-last-good'));
    await fs.writeFile(file, '{"access_token": "a",,,');
    const fallback = store.readAll()[0];
    assert.equal(fallback.generation, first.generation, 'a partial write falls back to the same material identity');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('N loaded credentials cap generation at 2N, OAuth at 2N and project probes at N', () => {
  const budget = createDispatchBudget({ credentials: 2 });
  for (const id of ['a', 'b']) {
    assert.equal(budget.takeGeneration(id), true);
    assert.equal(budget.takeGeneration(id), true);
    assert.equal(budget.takeGeneration(id), false, `${id}: connection and auth retries share two generation POSTs`);
    assert.equal(budget.takeOAuth(id), true);
    assert.equal(budget.takeOAuth(id), true);
    assert.equal(budget.takeOAuth(id), false);
    assert.equal(budget.takeProject(id), true);
    assert.equal(budget.takeProject(id), false, 'one project probe per credential');
  }
  assert.equal(budget.canTakeGeneration('c'), false);
  const counts = budget.counts();
  assert.deepEqual(
    [counts.generation, counts.oauth, counts.project, counts.maxGeneration, counts.maxOAuth, counts.maxProject],
    [4, 4, 2, 4, 4, 2],
  );
});

test('generation dispatches and the before-dispatch recheck run immediately before the wire', async () => {
  const upstream = client();
  upstream.accessToken = async () => 'token';
  const budget = createDispatchBudget({ credentials: 1 });
  let dispatches = 0;
  let checks = 0;
  upstream.request = async (url, { egressUrl } = {}) => {
    dispatches += 1;
    return { ok: true, status: 200, body: null, headers: {}, egressUrl };
  };
  const g1 = { id: '/creds/a.json', generation: 'g1', projectId: 'p' };
  const response = await upstream.generate({
    openAiBody: { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'synthetic' }] },
    account: g1,
    budget,
    beforeDispatch: async (meta) => {
      checks += 1;
      assert.equal(meta.generation, 'g1');
      assert.equal(meta.projectId, 'p');
      assert.equal(meta.outboundModel, 'gemini-3.8-flash-high');
    },
    requestId: '9f1c2d3e-4a5b-4c6d-8e7f-102132435465',
  });
  assert.equal(response.status, 200);
  assert.equal(dispatches, 1);
  assert.equal(checks, 1);
  assert.equal(budget.counts().generation, 1);
  // The second allowed POST is still admitted, then the per-credential allowance is spent.
  await upstream.generate({
    openAiBody: { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'synthetic' }] },
    account: g1,
    budget,
    beforeDispatch: async () => { checks += 1; },
  });
  assert.equal(dispatches, 2);
  await assert.rejects(
    upstream.generate({
      openAiBody: { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'synthetic' }] },
      account: g1,
      budget,
      beforeDispatch: async () => { checks += 1; },
    }),
    (error) => error instanceof UpstreamError && error.reason === 'budget_exhausted',
  );
  assert.equal(dispatches, 2, 'no third wire dispatch');
});

test('a pre-flight retry shares the same per-credential generation allowance', async () => {
  const upstream = client();
  upstream.accessToken = async () => 'token';
  const budget = createDispatchBudget({ credentials: 1 });
  let calls = 0;
  upstream.request = async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('synthetic socket failure'), { code: 'ECONNRESET' });
    return { ok: true, status: 200, body: null, headers: {} };
  };
  await upstream.generate({
    openAiBody: { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'synthetic' }] },
    account: { id: '/creds/a.json', generation: 'g1', projectId: 'p' },
    budget,
  });
  assert.equal(calls, 2);
  assert.equal(budget.counts().generation, 2, 'the retry consumed the second allowed dispatch');
  assert.equal(budget.canTakeGeneration('/creds/a.json'), false);
});

test('an egress failure is attributed to the egress and never falls back to a direct connection', async () => {
  const budget = createDispatchBudget({ credentials: 1 });
  const egressUrl = 'socks5://alice:secret@proxy.example:1080';
  const config = {
    upstream: {
      ...CONFIG.upstream,
      egress: { url: egressUrl },
    },
  };
  const upstream = client(config);
  upstream.accessToken = async () => 'token';
  const seen = [];
  upstream.request = async (url, options = {}) => {
    seen.push(options.egressUrl);
    throw new EgressError('synthetic CONNECT refusal', {
      stage: 'connect', reason: 'egress_unavailable', observedCode: 'connect_407', evidence: 'egress_connect',
    });
  };
  const accountWithEgress = { id: '/creds/a.json', generation: 'g1', projectId: 'p' };
  await assert.rejects(
    upstream.generate({
      openAiBody: { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'synthetic' }] },
      account: accountWithEgress,
      budget,
    }),
    (error) => error instanceof UpstreamError
      && error.origin === 'egress'
      && error.reason === 'egress_unavailable'
      && error.scope === 'egress'
      && error.egressKey === egressUrl
      && error.egressAlias.startsWith('egress-'),
  );
  assert.deepEqual(seen, [egressUrl, egressUrl], 'the retry uses the same pinned egress, never a direct connection');
  assert.equal(budget.counts().generation, 2);
});

test('a local timeout code is a timeout; a bare message is not evidence of one', async () => {
  const upstream = client();
  upstream.accessToken = async () => 'token';
  upstream.request = async () => { throw new Error('socket timed out while the proxy said nothing'); };
  await assert.rejects(
    upstream.generate({
      openAiBody: { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'synthetic' }] },
      account: { id: '/creds/a.json', generation: 'g1', projectId: 'p' },
      budget: createDispatchBudget({ credentials: 1 }),
    }),
    (error) => error instanceof UpstreamError && error.reason === 'unknown',
  );
  const timed = client();
  timed.accessToken = async () => 'token';
  timed.request = async () => { throw Object.assign(new Error('synthetic'), { code: 'ETIMEDOUT' }); };
  await assert.rejects(
    timed.generate({
      openAiBody: { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'synthetic' }] },
      account: { id: '/creds/a.json', generation: 'g1', projectId: 'p' },
      budget: createDispatchBudget({ credentials: 1 }),
    }),
    (error) => error instanceof UpstreamError && error.reason === 'timeout',
  );
});


test('same-millisecond refresh completion cannot let g1 overwrite g2', async (t) => {
  t.mock.method(Date, 'now', () => 1_000_000);
  const upstream = client();
  const first = deferred();
  const second = deferred();
  const p1 = upstream.accessToken(account('g1'), { fetchImpl: () => first.promise });
  const p2 = upstream.accessToken(account('g2'), { fetchImpl: () => second.promise });
  await new Promise((resolve) => setImmediate(resolve));
  second.resolve(tokenResponse('token-g2'));
  await p2;
  first.resolve(tokenResponse('token-g1'));
  await p1;
  assert.equal(upstream.tokens.get('/creds/a.json').token, 'token-g2');
});

test('late project resolution does not overwrite the newer generation project cache', async () => {
  const upstream = client();
  upstream.accessToken = async () => 'token';
  const first = deferred();
  let calls = 0;
  upstream.request = async () => (++calls === 1 ? first.promise : { ok: true, json: async () => ({ project: 'project-g2' }) });
  const p1 = upstream.ensureProject({ id: '/creds/a.json', generation: 'g1' });
  await new Promise((resolve) => setImmediate(resolve));
  await upstream.ensureProject({ id: '/creds/a.json', generation: 'g2' });
  first.resolve({ ok: true, json: async () => ({ project: 'project-g1' }) });
  await p1;
  assert.equal(upstream.projects.get('/creds/a.json').projectId, 'project-g2');
});

test('an observed unknown HTTP rejection is not retried as a connection failure', async () => {
  const upstream = client();
  upstream.accessToken = async () => 'token';
  let calls = 0;
  upstream.request = async () => { calls += 1; return { ok: false, status: 418, text: async () => '' }; };
  await assert.rejects(upstream.generate({
    openAiBody: { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'synthetic' }] },
    account: account('g1'), budget: createDispatchBudget({ credentials: 1 }),
  }), (error) => error.observedStatus === 418);
  assert.equal(calls, 1);
});

test('a synchronous dispatch check and the wire share one event-loop turn', async () => {
  const upstream = client();
  upstream.accessToken = async () => 'token';
  let valid = true;
  upstream.request = async () => { assert.equal(valid, true); return { ok: true, status: 200 }; };
  await upstream.generate({
    openAiBody: { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'synthetic' }] },
    account: account('g1'),
    beforeDispatch: () => { assert.equal(valid, true); queueMicrotask(() => { valid = false; }); },
  });
});


test('an OAuth CONNECT failure keeps its proven egress scope', async () => {
  const upstream = client({ upstream: { ...CONFIG.upstream, egress: { url: 'http://user:pass@proxy.example:1080' } } });
  await assert.rejects(upstream.accessToken(account('g1'), {
    fetchImpl: async () => { throw new EgressError('synthetic', { stage: 'connect', reason: 'egress_refused' }); },
  }), (error) => error.reason === 'egress_refused' && error.origin === 'egress' && error.egressKey === upstream.egressFor(account('g1')));
});
