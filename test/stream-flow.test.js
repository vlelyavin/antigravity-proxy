// Flow-aware attempt timing: the wait for the first meaningful frame, then the gap between
// meaningful frames. Both bound a socket the upstream holds open without progress; neither may
// extend the request deadline or the explicit ladder, and neither may rotate once the caller has
// started receiving a stream. Synthetic upstream, loopback only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { loadConfig } from '../src/config/load-config.js';
import { UpstreamClient , generationOf} from '../src/upstream/upstream-client.js';
import { AccountPool } from '../src/upstream/account-pool.js';
import { createServer } from '../src/server/create-server.js';
import { createFlowWatchdog } from '../src/server/handlers.js';

const CONFIG = loadConfig({ env: { ANTIGRAVITY_PROXY_PORT: '0', ANTIGRAVITY_PROXY_LOG_LEVEL: 'error' } });

const ACCOUNTS = [
  { generation: 'synthetic', id: 'a0', email: 'first@example.com', projectId: 'p' },
  { generation: 'synthetic', id: 'a1', email: 'second@example.com', projectId: 'p' },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const frame = (text, finishReason) => ({
  response: {
    candidates: [{
      content: { parts: typeof text === 'string' ? [{ text }] : [] },
      ...(finishReason ? { finishReason } : {}),
    }],
  },
});

function recorder() {
  const events = [];
  const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((level) => [
    level, (event, data = {}) => events.push({ level, event, ...data }),
  ]));
  return { logger, events };
}

/**
 * Synthetic antigravity lane. After the response headers it behaves per `mode`:
 *  - silent: holds the socket open and writes nothing
 *  - keepalive: writes empty candidate frames (a warm socket, not progress)
 *  - stall: one real text frame, then silence
 *  - flow: a text frame every gapMs, then a STOP frame (frames total)
 */
function lane({ mode = 'flow', gapMs = 20, frames = 8 } = {}) {
  const starts = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      starts.push(Date.now());
      const timers = [];
      const stop = () => { for (const timer of timers) clearInterval(timer); };
      res.on('close', stop);
      res.on('error', () => {});
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (mode === 'silent') return;
      if (mode === 'keepalive') {
        timers.push(setInterval(() => res.write(`data: ${JSON.stringify({ response: {} })}\n\n`), gapMs));
        return;
      }
      if (mode === 'stall') {
        res.write(`data: ${JSON.stringify(frame('partial'))}\n\n`);
        return;
      }
      let sent = 0;
      timers.push(setInterval(() => {
        sent += 1;
        if (sent < frames) {
          res.write(`data: ${JSON.stringify((mode === 'signature' ? { response: { candidates: [{ content: { parts: [{ thoughtSignature: 'synthetic-signature' }] } }] } } : frame('x')))}\n\n`);
          return;
        }
        res.write(`data: ${JSON.stringify(frame('x', 'STOP'))}\n\n`);
        res.end();
        stop();
      }, gapMs));
    });
  });
  return { server, starts };
}

async function startStage({ mode, gapMs, frames, rotation = {}, accounts = ACCOUNTS } = {}) {
  const { logger, events } = recorder();
  const upstream = lane({ mode, gapMs, frames });
  await once(upstream.server.listen(0), 'listening');
  const config = {
    ...CONFIG,
    upstream: {
      ...CONFIG.upstream,
      baseUrl: `http://127.0.0.1:${upstream.server.address().port}`,
      apiVersion: 'v1internal',
      requestTimeoutMs: 5000,
      eagerRefreshMs: 0,
      egress: { url: null },
    },
    rotation: { ...CONFIG.rotation, cooldownMs: 45_000, requestDeadlineMs: 5000, ...rotation },
    fallback: { enabled: false },
  };
  const client = new UpstreamClient({ currentGeneration: generationOf, config, logger });
  client.accessToken = async () => 'test-token';
  const pool = new AccountPool({ logger });
  const server = createServer({ config, credentialStore: { readAll: () => accounts }, upstream: client, pool, logger });
  await once(server.listen(0), 'listening');
  const close = () => {
    for (const s of [server, upstream.server]) { s.closeAllConnections(); s.close(); }
  };
  return { port: server.address().port, pool, events, starts: upstream.starts, close };
}

/** One non-stream chat, or the client SSE lane, or the native generateContent lane. */
async function request(port, { stream = false, native = false, headers = {} } = {}) {
  const startedAt = Date.now();
  const url = native
    ? `http://127.0.0.1:${port}/v1beta/models/gemini-3.8-flash:generateContent`
    : `http://127.0.0.1:${port}/v1/chat/completions`;
  const body = native
    ? { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }
    : { model: 'gemini-3.8-flash', stream, messages: [{ role: 'user', content: 'hi' }] };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, elapsedMs: Date.now() - startedAt };
}

test('an attempt with no meaningful frame rotates at the first-frame wait, cooling nobody', async () => {
  const stack = await startStage({ mode: 'silent', rotation: { firstMeaningfulFrameTimeoutMs: 120, idleTimeoutMs: 120 } });
  try {
    const res = await request(stack.port);
    assert.equal(res.status, 504, res.text);
    assert.equal(stack.starts.length, 2, 'the second account gets the rest of the request');
    assert.ok(res.elapsedMs >= 200 && res.elapsedMs < 2000, `elapsed ${res.elapsedMs}ms`);
    const attempts = stack.events.filter((e) => e.event === 'attempt.timing');
    assert.deepEqual(attempts.map((a) => a.outcome), ['first_frame_timeout', 'first_frame_timeout']);
    assert.deepEqual(attempts.map((a) => a.firstFrameMs), [null, null]);
    const request1 = stack.events.find((e) => e.event === 'request.timing');
    assert.equal(request1.outcome, 'failed');
    assert.equal(request1.status, 504);
    assert.equal(request1.attempts, 2);
    assert.equal(stack.pool.healthy(ACCOUNTS).length, 2, 'a stall is not an upstream quota/auth failure');
    assert.ok(!stack.events.some((e) => e.event === 'pool.restriction'));
  } finally {
    stack.close();
  }
});

test('keepalive frames keep the socket warm but do not satisfy the first-frame wait', async () => {
  const stack = await startStage({
    mode: 'keepalive', gapMs: 20, accounts: [ACCOUNTS[0]], rotation: { firstMeaningfulFrameTimeoutMs: 150, idleTimeoutMs: 150 },
  });
  try {
    const res = await request(stack.port);
    assert.equal(res.status, 504);
    assert.ok(res.elapsedMs >= 140 && res.elapsedMs < 1200, `keepalives must not buy a fresh first wait: ${res.elapsedMs}ms`);
    assert.equal(stack.starts.length, 1);
    const attempt = stack.events.find((e) => e.event === 'attempt.timing');
    assert.equal(attempt.outcome, 'first_frame_timeout');
    assert.equal(attempt.firstFrameMs, null, 'an empty candidate is not a meaningful frame');
    assert.equal(attempt.status, 504);
  } finally {
    stack.close();
  }
});

test('a response that outlives the first-frame wait while making progress succeeds', async () => {
  // 12 frames, 25 ms apart: the answer runs longer than the first-frame wait, every gap is a small
  // fraction of the idle wait (the margins stay wide when the machine is loaded)
  const collection = await startStage({ mode: 'flow', gapMs: 25, frames: 12, accounts: [ACCOUNTS[0]], rotation: { firstMeaningfulFrameTimeoutMs: 250, idleTimeoutMs: 250 } });
  try {
    const res = await request(collection.port);
    assert.equal(res.status, 200);
    const json = JSON.parse(res.text);
    assert.equal(json.choices[0].message.content, 'x'.repeat(12));
    assert.equal(json.choices[0].finish_reason, 'stop');
    assert.equal(collection.starts.length, 1, 'no rotation for a flowing answer');
    const attempt = collection.events.find((e) => e.event === 'attempt.timing');
    assert.equal(attempt.outcome, 'ok');
    assert.equal(typeof attempt.firstFrameMs, 'number');
  } finally {
    collection.close();
  }

  const streamed = await startStage({ mode: 'flow', gapMs: 25, frames: 12, accounts: [ACCOUNTS[0]], rotation: { firstMeaningfulFrameTimeoutMs: 250, idleTimeoutMs: 250 } });
  try {
    const res = await request(streamed.port, { stream: true });
    assert.equal(res.status, 200);
    assert.equal((res.text.match(/"content":"x"/g) ?? []).length, 12);
    assert.match(res.text, /\[DONE\]/);
    assert.ok(!streamed.events.some((e) => e.event === 'rotation.stall'), 'a flowing stream is never stalled');
    assert.equal(streamed.starts.length, 1);
  } finally {
    streamed.close();
  }
});

test('the idle wait cuts a stream that stops after progress, and no other account feeds it', async () => {
  const stack = await startStage({ mode: 'stall', accounts: ACCOUNTS, rotation: { firstMeaningfulFrameTimeoutMs: 2000, idleTimeoutMs: 120 } });
  try {
    const res = await request(stack.port, { stream: true });
    assert.equal(res.status, 200, 'the client stream was already open');
    assert.match(res.text, /"content":"partial"/);
    assert.match(res.text, /upstream stream failed/);
    assert.match(res.text, /\[DONE\]/);
    assert.equal(stack.starts.length, 1, 'a started client stream never receives another account');
    const attempt = stack.events.find((e) => e.event === 'attempt.timing');
    assert.equal(attempt.outcome, 'stream_failed');
    assert.match(attempt.reason, /idle_timeout/);
    assert.equal(stack.pool.healthy(ACCOUNTS).length, 2);
    const request1 = stack.events.find((e) => e.event === 'request.timing');
    assert.equal(request1.outcome, 'failed', 'the stream that failed is not reported as a success');
    assert.equal(request1.attempts, 1);
    // the timers of the attempt are gone: nothing else reports a stall for this request
    await sleep(200);
    const stalls = stack.events.filter((e) => e.event === 'rotation.stall');
    assert.equal(stalls.length, 1, 'one stall line, and the disposed timers add none');
    assert.equal(stalls[0].kind, 'idle_timeout');
    assert.equal(stalls[0].rotatable, false, 'a started client stream is never rotated');
    assert.equal(stack.events.filter((e) => e.event === 'attempt.timing').length, 1);
  } finally {
    stack.close();
  }
});

test('the request deadline still ends a flowing answer: progress never extends the total', async () => {
  const stack = await startStage({
    mode: 'flow', gapMs: 20, frames: 1000, accounts: [ACCOUNTS[0]], rotation: { requestDeadlineMs: 300, firstMeaningfulFrameTimeoutMs: 100, idleTimeoutMs: 100 },
  });
  try {
    const res = await request(stack.port);
    assert.equal(res.status, 504);
    assert.match(res.text, /request deadline/);
    assert.ok(res.elapsedMs < 1000, `a flowing answer must not outlive the budget: ${res.elapsedMs}ms`);
    const attempt = stack.events.find((e) => e.event === 'attempt.timing');
    assert.equal(attempt.outcome, 'deadline');
    const request1 = stack.events.find((e) => e.event === 'request.timing');
    assert.equal(request1.outcome, 'deadline');
    assert.equal(request1.deadlineMs, 300);
  } finally {
    stack.close();
  }
});

test('the native buffered lane keeps only the ladder and the budget, not the flow timers', async () => {
  const stack = await startStage({
    mode: 'silent', accounts: [ACCOUNTS[0]], rotation: { requestDeadlineMs: 350, firstMeaningfulFrameTimeoutMs: 40, idleTimeoutMs: 40 },
  });
  try {
    const res = await request(stack.port, { native: true, headers: { 'x-attempt-timeouts-ms': '500' } });
    assert.equal(res.status, 504);
    assert.ok(res.elapsedMs >= 300, `a JSON body has no frames to stall on: ${res.elapsedMs}ms`);
    assert.equal(stack.starts.length, 1, 'the flow timers do not exist on the native lane');
    const attempt = stack.events.find((e) => e.event === 'attempt.timing');
    assert.equal(attempt.outcome, 'deadline');
  } finally {
    stack.close();
  }
});

test('the flow watchdog clears its first wait on progress, re-arms idle, and leaves no timer', async () => {
  const startedAt = Date.now();
  const stalls = [];
  const flow = createFlowWatchdog({
    firstMeaningfulFrameMs: 120,
    idleMs: 120,
    onStall: (code) => stalls.push({ code, at: Date.now() - startedAt }),
  });
  await sleep(30);
  flow.progress(); // real progress before the first wait expires
  assert.equal(flow.satisfied, true);
  await sleep(60); // 90 ms from the start, 60 ms from the progress: neither wait may fire
  assert.deepEqual(stalls, []);
  await sleep(120); // 180 ms from the progress: the idle wait fired at 150 ms
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].code, 'idle_timeout');
  assert.ok(stalls[0].at >= 140, `idle fired at ${stalls[0].at}ms`);

  let late = 0;
  const disposed = createFlowWatchdog({ firstMeaningfulFrameMs: 30, idleMs: 30, onStall: () => { late += 1; } });
  disposed.progress();
  disposed.dispose();
  await sleep(120);
  assert.equal(late, 0, 'a disposed watchdog leaves no timer behind');
});

test('signature-only frames count as progress before translation drops empty deltas', { timeout: 5000 }, async () => {
  for (const stream of [false, true]) {
    const stack = await startStage({ mode: 'signature', gapMs: 25, frames: 12, accounts: [ACCOUNTS[0]],
      rotation: { firstMeaningfulFrameTimeoutMs: 150, idleTimeoutMs: 150 } });
    try {
      const result = await request(stack.port, { stream });
      assert.equal(result.status, 200);
      assert.ok(result.elapsedMs >= 250, 'the answer outlives the initial wait');
      assert.doesNotMatch(result.text, /upstream stream failed/);
      const attempt = stack.events.find((e) => e.event === 'attempt.timing');
      assert.equal(attempt.outcome, 'ok');
      assert.ok(attempt.firstFrameMs < 150, 'signature satisfies the first meaningful wait');
      assert.equal(stack.starts.length, 1);
    } finally {
      stack.close();
    }
  }
});
