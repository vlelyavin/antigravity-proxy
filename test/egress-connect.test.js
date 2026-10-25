// The production transport: node:https through the account's HTTP CONNECT tunnel. A fake HTTPS
// upstream behind a loopback CONNECT proxy, so cancellation, listener ownership and "abort after the
// headers destroys the stalled body" are exercised on the path production actually uses.
// TLS is verified against the committed test certificate; verification is never switched off.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import { once } from 'node:events';
import { loadConfig } from '../src/config/load-config.js';
import { UpstreamClient , generationOf} from '../src/upstream/upstream-client.js';
import { makeEgressAgent } from '../src/upstream/egress.js';
import { AccountPool } from '../src/upstream/account-pool.js';
import { handleWithRotation } from '../src/server/handlers.js';
import { accountLabel } from '../src/utils/alias.js';

const CONFIG = loadConfig({ env: { ANTIGRAVITY_PROXY_PORT: '0', ANTIGRAVITY_PROXY_LOG_LEVEL: 'error' } });
const KEY = fs.readFileSync(new URL('./fixtures/localhost-test-key.pem', import.meta.url));
const CERT = fs.readFileSync(new URL('./fixtures/localhost-test-cert.pem', import.meta.url));

const BODY = { model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'synthetic' }] };
const ACCOUNT = { generation: 'synthetic', id: 'a0', email: 'first@example.com', projectId: 'p' };
const ACCOUNTS = [ACCOUNT, { generation: 'synthetic', id: 'a1', email: 'second@example.com', projectId: 'p' }];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, timeoutMs = 2000, what = 'condition') {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`${what} was not met in time`);
    await sleep(5);
  }
}

function recorder() {
  const events = [];
  const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((level) => [
    level, (event, data = {}) => events.push({ level, event, ...data }),
  ]));
  return { logger, events };
}

const frame = (text, finishReason) => ({
  response: { candidates: [{ content: { parts: [{ text }] }, ...(finishReason ? { finishReason } : {}) }] },
});

/** Fake antigravity HTTPS upstream. `mode`: never (no headers) | silent | stall | ok. */
function lane() {
  const state = { mode: 'ok', requests: 0, closed: 0, tls: 0 };
  const server = https.createServer({ key: KEY, cert: CERT }, (req, res) => {
    state.requests += 1;
    req.resume();
    // IncomingMessage.close means the upload ended on Node >=16; response.close tracks
    // the stalled response being torn down by cancellation.
    res.on('close', () => { state.closed += 1; });
    res.on('error', () => {});
    req.on('end', () => {
      if (state.mode === 'never') return; // the caller waits for headers that never come
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (state.mode === 'silent') return;
      res.write(`data: ${JSON.stringify(frame('partial'))}\n\n`);
      if (state.mode === 'stall') return;
      res.write(`data: ${JSON.stringify(frame('tail', 'STOP'))}\n\n`);
      res.end();
    });
  });
  server.on('secureConnection', () => { state.tls += 1; });
  return { server, state };
}

/** A minimal HTTP CONNECT proxy: tunnels to the requested host:port and pipes both ways. */
function connectProxy() {
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
  return { server, connects };
}

async function startConnector({ mode = 'ok', egressUrl: given } = {}) {
  const { logger, events } = recorder();
  const upstreamLane = lane();
  upstreamLane.state.mode = mode;
  await once(upstreamLane.server.listen(0, '127.0.0.1'), 'listening');
  const proxy = connectProxy();
  await once(proxy.server.listen(0, '127.0.0.1'), 'listening');
  const egressUrl = given ?? `http://127.0.0.1:${proxy.server.address().port}`;
  const origin = `https://localhost:${upstreamLane.server.address().port}`;
  const config = {
    ...CONFIG,
    upstream: {
      ...CONFIG.upstream,
      baseUrl: origin,
      apiVersion: 'v1internal',
      requestTimeoutMs: 5000,
      eagerRefreshMs: 0,
      egress: { url: egressUrl },
    },
    rotation: { ...CONFIG.rotation, cooldownMs: 45_000, requestDeadlineMs: 5000 },
    fallback: { enabled: false },
  };
  const client = new UpstreamClient({ currentGeneration: generationOf, config, logger });
  client.accessToken = async () => 'synthetic-token';
  // the only test hook: a trust anchor for the committed self-signed certificate
  client.agentFor = () => makeEgressAgent({ egressUrl, tlsOptions: { ca: CERT } });
  const close = () => {
    for (const s of [upstreamLane.server, proxy.server]) { s.closeAllConnections(); s.close(); }
  };
  return { client, config, logger, events, lane: upstreamLane, proxy, origin, egressUrl, close };
}

test('the tunnel carries the request and TLS verification is on', async () => {
  const stack = await startConnector({ mode: 'ok' });
  try {
    const response = await stack.client.generateStream({ openAiBody: BODY, account: ACCOUNT, signal: null });
    assert.equal(response.ok, true);
    let text = '';
    for await (const chunk of response.body) text += chunk;
    assert.match(text, /"finishReason":"STOP"/);
    assert.equal(stack.lane.state.tls, 1, 'the CONNECT tunnel reached a real TLS handshake');
    assert.deepEqual(stack.proxy.connects, [`localhost:${new URL(stack.origin).port}`]);
  } finally {
    stack.close();
  }
});

test('a caller cancelled before the response headers drops the request and the tunnel', async () => {
  const stack = await startConnector({ mode: 'never' });
  try {
    const leaving = new AbortController();
    const reason = new Error('client disconnected');
    const pending = stack.client.generateStream({ openAiBody: BODY, account: ACCOUNT, signal: leaving.signal });
    await until(() => stack.lane.state.requests === 1, 2000, 'the upstream request');
    leaving.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    await until(() => stack.lane.state.closed === 1, 2000, 'the upstream socket to close');
    assert.equal(stack.lane.state.requests, 1, 'a cancelled caller never retries');
  } finally {
    stack.close();
  }
});

test('a caller cancelled during a stalled SSE destroys the body, not just the promise', async () => {
  const stack = await startConnector({ mode: 'stall' });
  try {
    const leaving = new AbortController();
    const reason = new Error('client disconnected');
    const response = await stack.client.generateStream({ openAiBody: BODY, account: ACCOUNT, signal: leaving.signal });
    const body = response.body[Symbol.asyncIterator]();
    const first = await body.next();
    assert.match(String(first.value), /partial/);
    leaving.abort(reason);
    await assert.rejects(body.next(), (error) => error !== undefined && error !== null);
    await until(() => stack.lane.state.closed === 1, 2000, 'the stalled body to be destroyed upstream');
    assert.equal(stack.lane.state.requests, 1);
  } finally {
    stack.close();
  }
});

test('a normal completion leaves no abort listener on the request signal', async () => {
  const stack = await startConnector({ mode: 'ok' });
  try {
    const controller = new AbortController();
    const signal = controller.signal;
    // count the listener lifecycle of exactly this signal
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    let added = 0;
    let removed = 0;
    signal.addEventListener = (...args) => { added += 1; return add(...args); };
    signal.removeEventListener = (...args) => { removed += 1; return remove(...args); };
    const response = await stack.client.request(`${stack.origin}/v1internal:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: '{}',
      signal,
      egressUrl: stack.egressUrl,
    });
    let text = '';
    for await (const chunk of response.body) text += chunk;
    assert.match(text, /STOP/);
    await until(() => added > 0 && removed === added, 2000, 'the abort listener to be removed');
    assert.equal(added, removed);
    // and the signal still works for the next request: it was not left wired to a dead one
    assert.equal(signal.aborted, false);
  } finally {
    stack.close();
  }
});

test('cancellation through the rotation retries nothing and cools nobody', async () => {
  const stack = await startConnector({ mode: 'stall' });
  try {
    const pool = new AccountPool({ logger: stack.logger });
    const leaving = new AbortController();
    const reason = new Error('client disconnected');
    const res = {
      headersSent: false,
      writableEnded: false,
      destroyed: false,
      chunks: [],
      writeHead() { this.headersSent = true; },
      write(chunk) { this.chunks.push(chunk); return true; },
      end() { this.writableEnded = true; },
      on() {}, once() {}, off() {}, removeListener() {},
    };
    const pending = handleWithRotation({
      pool,
      store: { readAll: () => ACCOUNTS },
      upstream: stack.client,
      config: stack.config,
      logger: stack.logger,
      openAiBody: { ...BODY, stream: true },
      res,
      signal: leaving.signal,
    }).then(() => null, (error) => error);
    await until(() => res.chunks.length > 0, 2000, 'the first client frame');
    leaving.abort(reason);
    // the request rejects (the socket noise of the destroyed body may be what surfaces); what
    // matters is the classification below: a caller that left is not an upstream failure
    assert.ok((await pending) instanceof Error);
    assert.equal(stack.lane.state.requests, 1, 'a cancelled caller never starts another account');
    assert.equal(pool.healthy(ACCOUNTS).length, 2, 'a caller that left is not an upstream failure');
    assert.ok(!stack.events.some((e) => e.event === 'pool.restriction'));
    const attempt = stack.events.find((e) => e.event === 'attempt.timing');
    assert.equal(attempt.outcome, 'client_abort');
    assert.equal(attempt.account, accountLabel(ACCOUNT));
    await until(() => stack.lane.state.closed === 1, 2000, 'the upstream socket to close');
  } finally {
    stack.close();
  }
});
