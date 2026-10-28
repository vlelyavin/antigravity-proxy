// F1 (audit 2026-10-28, owner rule 1): an account with no exit must FAIL CLOSED.
//
// The audited defect: `#fetchVia` returned `globalThis.fetch` for an account absent from
// `upstream.egress.accounts`, so its OAuth refresh - and, on the generation path, its traffic -
// would leave from the host IP. A deployment that declares per-account exits must never dial
// directly for an account it failed to map.
//
// The test proves the absence of the dial, not its failure: `globalThis.fetch` is replaced by a
// recorder, so a direct attempt is visible as a call instead of leaving the machine. Everything
// else runs on 127.0.0.1 through a real CONNECT tunnel, like production.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import { once } from 'node:events';
import { loadConfig } from '../src/config/load-config.js';
import { UpstreamClient, generationOf } from '../src/upstream/upstream-client.js';
import { makeEgressAgent } from '../src/upstream/egress.js';
import { AccountPool } from '../src/upstream/account-pool.js';
import { createServer } from '../src/server/create-server.js';

const CONFIG = loadConfig({ env: { ANTIGRAVITY_PROXY_PORT: '0', ANTIGRAVITY_PROXY_LOG_LEVEL: 'error' } });
const KEY = fs.readFileSync(new URL('./fixtures/localhost-test-key.pem', import.meta.url));
const CERT = fs.readFileSync(new URL('./fixtures/localhost-test-cert.pem', import.meta.url));

const UNMAPPED = { generation: 'synthetic-a', id: '/creds/unmapped.json', email: 'unmapped@example.test', projectId: 'p' };
const MAPPED = { generation: 'synthetic-b', id: '/creds/mapped.json', email: 'mapped@example.test', projectId: 'p' };

function recorder() {
  const events = [];
  const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((level) => [
    level, (event, data = {}) => events.push({ level, event, ...data }),
  ]));
  return { logger, events };
}

/** Fake antigravity HTTPS origin: one SSE answer, and a count of who reached it. */
async function origin() {
  const state = { requests: 0, tokens: [] };
  const server = https.createServer({ key: KEY, cert: CERT }, (req, res) => {
    state.requests += 1;
    state.tokens.push(String(req.headers.authorization || ''));
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'served' }] }, finishReason: 'STOP' }] } })}\n\n`);
      res.end();
    });
  });
  await once(server.listen(0, '127.0.0.1'), 'listening');
  return { server, state, url: `https://localhost:${server.address().port}` };
}

/** A minimal HTTP CONNECT proxy: one exit lane per account. */
async function lane() {
  const connects = [];
  const server = http.createServer((req, res) => { res.writeHead(405); res.end(); });
  server.on('connect', (req, socket, head) => {
    connects.push(req.url);
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
  });
  await once(server.listen(0, '127.0.0.1'), 'listening');
  return { server, connects, url: `http://127.0.0.1:${server.address().port}` };
}

/**
 * Starts a relay whose egress map covers only `MAPPED`. The unmapped account is first in file
 * order, so sticky-first selection reaches it first: the exact shape of audit scenario S15.
 */
async function stack() {
  const upstreamOrigin = await origin();
  const laneB = await lane();
  const { logger, events } = recorder();
  const config = {
    ...CONFIG,
    upstream: {
      ...CONFIG.upstream,
      baseUrl: upstreamOrigin.url,
      apiVersion: 'v1internal',
      requestTimeoutMs: 5000,
      eagerRefreshMs: 0,
      // no global url: the per-account map is the whole exit policy
      egress: { accounts: { 'mapped@example.test': laneB.url } },
    },
    rotation: { ...CONFIG.rotation, requestDeadlineMs: 5000 },
    fallback: { enabled: false },
  };
  const client = new UpstreamClient({ currentGeneration: generationOf, config, logger });
  // The mapped account already holds a valid access token: its preparation never needs the token
  // endpoint, so the test exercises the production code path (assertEgress first) without a refresh.
  client.tokens.set(MAPPED.id, {
    token: `token|${MAPPED.id}`, expiresAt: Date.now() + 3600_000, generation: MAPPED.generation, version: 0,
  });
  // the only test hook: a trust anchor for the committed self-signed certificate
  client.agentFor = () => makeEgressAgent({ egressUrl: laneB.url, tlsOptions: { ca: CERT } });
  const pool = new AccountPool({ logger });
  const store = { readAll: () => [UNMAPPED, MAPPED] };
  const server = createServer({ config, credentialStore: store, upstream: client, pool, logger });
  await once(server.listen(0, '127.0.0.1'), 'listening');
  const close = () => {
    for (const s of [server, upstreamOrigin.server, laneB.server]) { s.closeAllConnections(); s.close(); }
  };
  return { client, config, logger, events, port: server.address().port, origin: upstreamOrigin, lane: laneB, close };
}

test('an account with no exit never dials directly: it fails closed and another account serves', async () => {
  const stackUnderTest = await stack();
  const direct = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    direct.push({ url: String(url), method: options?.method ?? 'GET' });
    throw new Error('a direct dial is forbidden by the owner rule');
  };
  try {
    // the deployment declares exits, so the unmapped first account is a configuration gap: syncEgress
    // reports it (alias only) and the account resolves to no exit at all
    const report = stackUnderTest.client.syncEgress([UNMAPPED, MAPPED]);
    assert.equal(report.missing.length, 1, 'the unmapped account is reported, by alias');
    assert.doesNotMatch(report.missing[0], /unmapped|creds/, 'the journal alias never carries the path or email');
    assert.equal(stackUnderTest.client.egressFor(UNMAPPED), null);
    assert.equal(stackUnderTest.events.filter((event) => event.event === 'egress.missing').length, 1);

    // OAuth refresh: the token POST is the first place the host IP could leak
    await assert.rejects(
      () => stackUnderTest.client.accessToken({ ...UNMAPPED, refreshToken: 'synthetic-refresh' }),
      (error) => {
        assert.equal(error.reason, 'egress_unavailable', 'the failure is an egress failure');
        assert.equal(error.scope, 'egress', 'never a credential penalty: another account must serve');
        assert.equal(error.evidence, 'egress_config');
        return true;
      },
    );

    // generation: project resolution and the POST both refuse
    await assert.rejects(
      () => stackUnderTest.client.generate({
        openAiBody: { model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'synthetic' }] },
        account: UNMAPPED,
      }),
      (error) => error.reason === 'egress_unavailable' && error.scope === 'egress',
    );

    // and through the real server the request is still served, by the mapped account only
    const response = await realFetch(`http://127.0.0.1:${stackUnderTest.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'synthetic' }] }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, 'served');

    assert.deepEqual(direct, [], 'no OAuth refresh, project probe or generation left from the host IP');
    assert.equal(stackUnderTest.origin.state.requests, 1, 'exactly one generation reached the origin');
    assert.equal(stackUnderTest.origin.state.tokens[0], `Bearer token|${MAPPED.id}`, 'the mapped account served it');
    assert.deepEqual(stackUnderTest.lane.connects, [`localhost:${new URL(stackUnderTest.origin.url).port}`]);
    const failures = stackUnderTest.events.filter((event) => event.event === 'attempt.timing' && event.failureReason);
    assert.ok(failures.some((event) => event.failureReason === 'egress_unavailable' && event.failureScope === 'egress'));
    assert.ok(!stackUnderTest.events.some((event) => event.event === 'pool.restriction'
      && event.scope === 'credential'), 'an unmapped account is not a revoked credential');
  } finally {
    globalThis.fetch = realFetch;
    stackUnderTest.close();
  }
});

test('a deployment with no egress at all still uses the host connection (the documented local relay)', async () => {
  // the plain local relay: no lane, no global url - the host IP is the documented exit, so the
  // fail-closed rule must not turn every unmapped account into an outage
  const { logger } = recorder();
  const client = new UpstreamClient({
    currentGeneration: generationOf,
    logger,
    config: { upstream: { eagerRefreshMs: 0, egress: { url: null } } },
  });
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    seen.push({ url: String(url), transport: 'host', body: String(options?.body ?? '') });
    return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
  };
  try {
    assert.equal(await client.accessToken({ ...UNMAPPED, refreshToken: 'synthetic-refresh' }), 'tok');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seen.length, 1, 'a no-egress deployment refreshes through the host connection');
  assert.match(seen[0].url, /^https:\/\/oauth2\.googleapis\.com\/token$/, 'the recorded call is the token POST, never dialled here');
  assert.equal(client.egressIdentityFor(UNMAPPED).alias, 'direct');
});
