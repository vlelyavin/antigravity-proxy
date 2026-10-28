// F2 (audit 2026-10-28, owner rule 1): two accounts of one service must never share an exit.
//
// The audited defect: nothing resolved egress identities at start-up, so two credentials mapped to
// one lane were both accepted and both dialled it (audit scenario S16). The rule is now enforced
// where the identity is resolved - at start-up and on every credential load - and the later account
// fails closed instead of serving on a shared IP. The relay itself keeps running: a configuration
// mistake in one lane must not take the whole service down.
//
// The test observes the lane itself, so "refused" means "never connected", not "not selected".
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
import { accountLabel } from '../src/utils/alias.js';

const CONFIG = loadConfig({ env: { ANTIGRAVITY_PROXY_PORT: '0', ANTIGRAVITY_PROXY_LOG_LEVEL: 'error' } });
const KEY = fs.readFileSync(new URL('./fixtures/localhost-test-key.pem', import.meta.url));
const CERT = fs.readFileSync(new URL('./fixtures/localhost-test-cert.pem', import.meta.url));

const SHARED_LANE = 'shared.exclusive';
const FIRST = { generation: 'gen-first', id: '/creds/first.json', email: 'first@example.test', projectId: 'p' };
const SECOND = { generation: 'gen-second', id: '/creds/second.json', email: 'second@example.test', projectId: 'p' };

function recorder() {
  const events = [];
  const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((level) => [
    level, (event, data = {}) => events.push({ level, event, ...data }),
  ]));
  return { logger, events };
}

/** One CONNECT proxy reported under two names: it is the single exit both accounts would use. */
async function sharedLane() {
  const connects = [];
  const server = http.createServer((req, res) => { res.writeHead(405); res.end(); });
  server.on('connect', (req, socket, head) => {
    connects.push({ url: req.url, auth: req.headers['proxy-authorization'] ?? null });
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

async function origin() {
  const state = { requests: [] };
  const server = https.createServer({ key: KEY, cert: CERT }, (req, res) => {
    state.requests.push(String(req.headers.authorization || ''));
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

/** The production start-up shape: one lane url used by both accounts, no global egress url. */
async function stack() {
  const upstreamOrigin = await origin();
  const lane = await sharedLane();
  const { logger, events } = recorder();
  const config = {
    ...CONFIG,
    upstream: {
      ...CONFIG.upstream,
      baseUrl: upstreamOrigin.url,
      apiVersion: 'v1internal',
      requestTimeoutMs: 5000,
      eagerRefreshMs: 0,
      egress: { accounts: { [FIRST.email]: lane.url, [SECOND.email]: lane.url } },
    },
    rotation: { ...CONFIG.rotation, requestDeadlineMs: 5000 },
    fallback: { enabled: false },
  };
  const client = new UpstreamClient({ currentGeneration: generationOf, config, logger });
  client.tokens.set(FIRST.id, {
    token: `token|${FIRST.id}`, expiresAt: Date.now() + 3600_000, generation: FIRST.generation, version: 0,
  });
  client.agentFor = () => makeEgressAgent({ egressUrl: lane.url, tlsOptions: { ca: CERT } });
  const pool = new AccountPool({ logger });
  const store = { readAll: () => [FIRST, SECOND] };
  const server = createServer({ config, credentialStore: store, upstream: client, pool, logger });
  await once(server.listen(0, '127.0.0.1'), 'listening');
  const close = () => {
    for (const s of [server, upstreamOrigin.server, lane.server]) { s.closeAllConnections(); s.close(); }
  };
  return { client, config, logger, events, pool, port: server.address().port, origin: upstreamOrigin, lane, close };
}

test('two accounts on one exit: the later account is refused and never reaches the shared lane', async () => {
  const stackUnderTest = await stack();
  try {
    // start-up: the identity is resolved per account and the duplicate claim is refused
    const report = stackUnderTest.client.syncEgress([FIRST, SECOND]);
    assert.deepEqual(report.refused, [SECOND.id], 'the later account loses the lane, the first keeps it');
    assert.equal(stackUnderTest.client.egressFor(FIRST), stackUnderTest.client.egressFor(SECOND),
      'both still resolve to the same configured url - the config itself is the mistake');
    assert.equal(stackUnderTest.client.egressFor(SECOND),
      stackUnderTest.lane.url);

    // the journal names the collision by alias only, and reports the first holder
    const duplicate = stackUnderTest.events.find((event) => event.event === 'egress.duplicate');
    assert.ok(duplicate, 'a clear error line reports the shared exit');
    assert.equal(duplicate.level, 'error');
    assert.equal(duplicate.account, accountLabel(SECOND));
    assert.equal(duplicate.first, accountLabel(FIRST));
    assert.match(duplicate.egress, /^egress-[0-9a-f]{8}$/);
    assert.doesNotMatch(JSON.stringify(duplicate), /second@example|first@example|creds\/|127\.0\.0\.1/,
      'the collision line carries aliases, never emails, paths or the proxy url');

    // the refused account fails closed: no OAuth refresh, no project probe, no generation
    const failure = await stackUnderTest.client.generate({
      openAiBody: { model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'synthetic' }] },
      account: { ...SECOND, refreshToken: 'synthetic-refresh' },
    }).then(() => null, (error) => error);
    assert.ok(failure, 'the refused account cannot serve');
    assert.equal(failure.reason, 'egress_invalid_config');
    assert.equal(failure.scope, 'egress', 'an egress refusal never penalizes the credential');
    assert.equal(stackUnderTest.client.egressIdentityFor(SECOND).key, null,
      'the refused account has no lane identity, so the shared lane is never gated for it');

    // and the service keeps running: the first account serves the real request over the one lane
    const response = await fetch(`http://127.0.0.1:${stackUnderTest.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'synthetic' }] }),
    });
    assert.equal(response.status, 200, 'the relay is not refused as a whole');
    const body = await response.json();
    assert.equal(body.choices[0].message.content, 'served');
    assert.equal(stackUnderTest.lane.connects.length, 1);
    assert.deepEqual(stackUnderTest.origin.state.requests, [`Bearer token|${FIRST.id}`],
      'every generation on the shared lane came from the one account that owns it');
  } finally {
    stackUnderTest.close();
  }
});

test('the reload path re-decides: a removed duplicate frees the lane, a returning one is refused', async () => {
  const stackUnderTest = await stack();
  try {
    stackUnderTest.client.syncEgress([FIRST, SECOND]);
    assert.deepEqual([...stackUnderTest.client.egressRefused.keys()], [SECOND.id]);
    const afterStart = stackUnderTest.events.filter((event) => event.event === 'egress.duplicate').length;

    // every request reloads the credential set and re-runs the check: an unchanged set stays quiet
    stackUnderTest.client.syncEgress([FIRST, SECOND]);
    stackUnderTest.client.syncEgress([FIRST, SECOND]);
    assert.equal(stackUnderTest.events.filter((event) => event.event === 'egress.duplicate').length, afterStart,
      'an unchanged configuration is journaled once, not once per request');

    // the duplicate claim disappears with its credential: nothing is refused any more
    stackUnderTest.client.syncEgress([FIRST]);
    assert.equal(stackUnderTest.client.egressRefused.size, 0);
    assert.equal(stackUnderTest.client.egressIdentityFor(SECOND).key, stackUnderTest.lane.url,
      'refusal follows the credential set, not a stale memorised verdict');

    // and a reload that brings a second claimant back refuses it again (a real transition, journaled)
    stackUnderTest.client.syncEgress([FIRST, SECOND]);
    assert.deepEqual([...stackUnderTest.client.egressRefused.keys()], [SECOND.id]);
    assert.equal(stackUnderTest.events.filter((event) => event.event === 'egress.duplicate').length, afterStart + 1);
  } finally {
    stackUnderTest.close();
  }
});

test('a global egress url shared by several accounts is one exit, so the later ones are refused too', () => {
  // upstream.egress.url is a single proxy: every account inheriting it reaches Google from the same
  // IP, which is exactly the sharing the owner rule forbids. It is refused like any other duplicate
  // claim - the journal names the pair, and the operator's fix is a per-account map.
  const { logger, events } = recorder();
  const client = new UpstreamClient({
    currentGeneration: generationOf,
    logger,
    config: { upstream: { egress: { url: 'socks5://127.0.0.1:1055' } } },
  });
  const report = client.syncEgress([FIRST, SECOND]);
  assert.deepEqual(report.refused, [SECOND.id], 'the first account keeps the one exit');
  assert.deepEqual(report.missing, [], 'the exit exists: this is a sharing refusal, not a gap');
  assert.equal(events.filter((event) => event.event === 'egress.duplicate').length, 1);
  assert.equal(client.egressIdentityFor(SECOND).key, null);
  assert.equal(client.egressIdentityFor(FIRST).key, 'socks5://127.0.0.1:1055');

  // one account on a global url is fine: no duplicate, no refusal
  assert.deepEqual(client.syncEgress([FIRST]).refused, []);
  assert.equal(client.egressIdentityFor(FIRST).key, 'socks5://127.0.0.1:1055');

  // two *distinct* lanes are the healthy case: no refusal, no journal noise
  const split = new UpstreamClient({
    currentGeneration: generationOf,
    logger,
    config: { upstream: { egress: { accounts: { [FIRST.email]: 'http://127.0.0.1:21143', [SECOND.email]: 'http://127.0.0.1:21144' } } } },
  });
  assert.deepEqual(split.syncEgress([FIRST, SECOND]).refused, []);
  assert.notEqual(split.egressIdentityFor(FIRST).alias, split.egressIdentityFor(SECOND).alias);
});

test('two authenticated sessions on one host:port are distinct exits, not a shared lane', () => {
  // the egress identity is the whole configured url, credentials included: two residential sessions
  // that happen to share host:port are different IPs, so this is not the forbidden sharing
  const { logger } = recorder();
  const client = new UpstreamClient({
    currentGeneration: generationOf,
    logger,
    config: {
      upstream: {
        egress: {
          accounts: {
            [FIRST.email]: 'socks5://alice:secret@127.0.0.1:1055',
            [SECOND.email]: 'socks5://bob:other@127.0.0.1:1055',
          },
        },
      },
    },
  });
  assert.deepEqual(client.syncEgress([FIRST, SECOND]).refused, []);
  assert.notEqual(client.egressIdentityFor(FIRST).key, client.egressIdentityFor(SECOND).key);
});
