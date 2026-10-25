// Strict terminal outcome at the handler boundary: a generation ends successfully only with a
// documented finish reason. MALFORMED_FUNCTION_CALL, LANGUAGE, OTHER, an unspecified or an unknown
// reason is a protocol failure - never a fabricated `stop` - on the collection, the plain-JSON
// branch and the client stream alike. Synthetic frames only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { loadConfig } from '../src/config/load-config.js';
import { AccountPool } from '../src/upstream/account-pool.js';
import { UpstreamClient, UpstreamError } from '../src/upstream/upstream-client.js';
import { createServer } from '../src/server/create-server.js';
import { handleWithRotation, isSuccessfulTerminal } from '../src/server/handlers.js';

const CONFIG = loadConfig({ env: { ANTIGRAVITY_PROXY_PORT: '0', ANTIGRAVITY_PROXY_LOG_LEVEL: 'error' } });
const CONFIG_NO_FALLBACK = {
  apiKey: null,
  upstream: { requestTimeoutMs: 2000, egress: { url: null } },
  rotation: { cooldownMs: 45_000, requestDeadlineMs: 5000 },
  fallback: { enabled: false },
};

const ACCOUNTS = [
  { id: 'a0', email: 'first@example.com', projectId: 'p' },
  { id: 'a1', email: 'second@example.com', projectId: 'p' },
];
const BODY = { model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'synthetic' }], stream: false };

const frame = (parts, finishReason) => ({
  response: { candidates: [{ content: { parts }, ...(finishReason !== undefined ? { finishReason } : {}) }] },
});

function recorder() {
  const events = [];
  const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((level) => [
    level, (event, data = {}) => events.push({ level, event, ...data }),
  ]));
  return { logger, events };
}

function sse(frames) {
  const body = frames.map((entry) => `data: ${JSON.stringify(entry)}\n\n`).join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

/** One non-stream request through the rotation handler against a stubbed upstream. */
async function collect({ responses, accounts = ACCOUNTS }) {
  const { logger, events } = recorder();
  const pool = new AccountPool({ logger });
  let call = 0;
  const upstream = {
    invalidate() {},
    async generateStream() {
      // each call gets the next response; the last one repeats
      return responses[Math.min(call++, responses.length - 1)];
    },
  };
  let raw = null;
  const res = { headersSent: false, writeHead() { this.headersSent = true; }, end(value) { raw = JSON.parse(value); } };
  await handleWithRotation({
    pool, store: { readAll: () => accounts }, upstream, config: CONFIG_NO_FALLBACK, logger, openAiBody: BODY, res, signal: null,
  });
  return { raw, pool, events };
}

/** One client-stream request through a real relay in front of a synthetic upstream. */
async function collectStream({ frames, accounts = [ACCOUNTS[0]] }) {
  const { logger, events } = recorder();
  const upstreamServer = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const entry of frames) res.write(`data: ${JSON.stringify(entry)}\n\n`);
      res.end();
    });
  });
  await once(upstreamServer.listen(0), 'listening');
  const config = {
    ...CONFIG,
    upstream: {
      ...CONFIG.upstream,
      baseUrl: `http://127.0.0.1:${upstreamServer.address().port}`,
      apiVersion: 'v1internal',
      requestTimeoutMs: 2000,
      eagerRefreshMs: 0,
      egress: { url: null },
    },
    fallback: { enabled: false },
  };
  const client = new UpstreamClient({ config, logger });
  client.accessToken = async () => 'test-token';
  const pool = new AccountPool({ logger });
  const server = createServer({ config, credentialStore: { readAll: () => accounts }, upstream: client, pool, logger });
  await once(server.listen(0), 'listening');
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-3.8-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    return { status: res.status, text: await res.text(), events, pool };
  } finally {
    server.closeAllConnections();
    server.close();
    upstreamServer.closeAllConnections();
    upstreamServer.close();
  }
}

test('only the documented finish reasons are a successful end', () => {
  for (const reason of ['STOP', 'MAX_TOKENS', 'SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']) {
    assert.equal(isSuccessfulTerminal(reason), true, reason);
  }
  for (const reason of ['MALFORMED_FUNCTION_CALL', 'LANGUAGE', 'OTHER', 'IMAGE_SAFETY', 'NO_IMAGE', 'FINISH_REASON_UNSPECIFIED', 'UNEXPECTED_TOOL_CALL', 'THING_THAT_DOES_NOT_EXIST', '', null]) {
    assert.equal(isSuccessfulTerminal(reason), false, String(reason));
  }
});

test('STOP, MAX_TOKENS and a safety block keep their documented mapping', async () => {
  const stop = await collect({ responses: [sse([frame([{ text: 'done' }], 'STOP')])], accounts: [ACCOUNTS[0]] });
  assert.equal(stop.raw.choices[0].finish_reason, 'stop');
  const length = await collect({ responses: [sse([frame([{ text: 'cut' }], 'MAX_TOKENS')])], accounts: [ACCOUNTS[0]] });
  assert.equal(length.raw.choices[0].finish_reason, 'length');
  const safety = await collect({ responses: [sse([frame([{ text: 'x' }], 'SAFETY')])], accounts: [ACCOUNTS[0]] });
  assert.equal(safety.raw.choices[0].finish_reason, 'content_filter');
  const promptBlock = await collect({ responses: [sse([{ response: { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } } }])], accounts: [ACCOUNTS[0]] });
  assert.equal(promptBlock.raw.choices[0].finish_reason, 'content_filter');
  assert.equal(promptBlock.raw.choices[0].message.refusal, 'PROHIBITED_CONTENT');
});

test('MALFORMED_FUNCTION_CALL fails the attempt and rotates like any other pre-header 502', async () => {
  const { raw, pool, events } = await collect({
    responses: [
      sse([frame([{ text: 'partial' }], 'MALFORMED_FUNCTION_CALL')]),
      sse([frame([{ text: 'second account' }], 'STOP')]),
    ],
  });
  assert.equal(raw.choices[0].finish_reason, 'stop');
  assert.equal(raw.choices[0].message.content, 'second account');
  // nothing was written to the caller, so the request is classified by the existing pre-header
  // 502 rule (transient: cool and fail over) - this change does not touch that policy
  assert.deepEqual(pool.healthy(ACCOUNTS).map((a) => a.id), ['a1']);
  const attempts = events.filter((e) => e.event === 'attempt.timing');
  assert.equal(attempts[0].outcome, 'transient');
  assert.equal(attempts[0].reason, 'terminal:502', 'the journal carries the terminal category');
  assert.equal(attempts[1].outcome, 'ok');
});

test('an unexpected or unknown finish reason never becomes stop', async () => {
  for (const reason of ['LANGUAGE', 'OTHER', 'IMAGE_SAFETY', 'FINISH_REASON_UNSPECIFIED', 'PROVIDER_INVENTED_THIS']) {
    await assert.rejects(
      collect({ responses: [sse([frame([{ text: 'partial' }], reason)])], accounts: [ACCOUNTS[0]] }),
      (error) => error instanceof UpstreamError && error.kind === 'terminal' && error.status === 502,
      reason,
    );
  }
});

test('a plain JSON body on the SSE endpoint is held to the same terminal rule', async () => {
  const { logger } = recorder();
  const upstreamJson = (json) => ({
    invalidate() {},
    async generateStream() { return Response.json(json); },
  });
  const run = async (json) => {
    const res = { headersSent: false, writeHead() { this.headersSent = true; }, end() {} };
    return handleWithRotation({
      pool: new AccountPool({ logger }), store: { readAll: () => [ACCOUNTS[0]] }, upstream: upstreamJson(json),
      config: CONFIG_NO_FALLBACK, logger, openAiBody: BODY, res, signal: null,
    });
  };
  await assert.rejects(run(frame([{ text: 'x' }], 'MALFORMED_FUNCTION_CALL')), (error) => error instanceof UpstreamError && error.kind === 'terminal');
  await assert.rejects(run(frame([{ text: 'x' }], 'OTHER')), (error) => error instanceof UpstreamError && error.kind === 'terminal');
  // the documented paths on the same branch are untouched
  const ok = await run(frame([{ text: 'complete' }], 'STOP'));
  assert.equal(ok, undefined);
  await assert.rejects(run(frame([{ text: 'no terminal' }])), (error) => error instanceof UpstreamError && error.kind === 'truncated');
});

test('an unsuccessful terminal in the client stream is an error frame, not a clean stop', async () => {
  const { status, text, events } = await collectStream({
    // the realistic shape: text first, then a terminal frame that must never be reported as a stop
    frames: [frame([{ text: 'partial' }]), frame([], 'MALFORMED_FUNCTION_CALL')],
    accounts: ACCOUNTS,
  });
  assert.equal(status, 200, 'the client stream was already open');
  assert.match(text, /"content":"partial"/, 'what the caller already received is not retracted');
  assert.match(text, /unsuccessful finish reason: MALFORMED_FUNCTION_CALL/);
  assert.match(text, /\[DONE\]/);
  assert.ok(!/"finish_reason":"stop"/.test(text), 'never reported as a completed generation');
  const attempts = events.filter((e) => e.event === 'attempt.timing');
  assert.equal(attempts.length, 1, 'no second account feeds a started stream');
  assert.equal(attempts[0].outcome, 'stream_failed');
  assert.equal(attempts[0].reason, 'terminal:502');
  const request1 = events.find((e) => e.event === 'request.timing');
  assert.equal(request1.outcome, 'failed');
});

test('a client stream that ends without a terminal frame fails instead of sending a lone DONE', async () => {
  const { status, text, events } = await collectStream({ frames: [frame([{ text: 'unfinished' }])] });
  assert.equal(status, 200);
  assert.match(text, /upstream stream failed/);
  assert.match(text, /\[DONE\]/);
  const attempt = events.find((e) => e.event === 'attempt.timing');
  assert.equal(attempt.outcome, 'stream_failed');
  assert.equal(attempt.reason, 'truncated:502');
  const request1 = events.find((e) => e.event === 'request.timing');
  assert.equal(request1.outcome, 'failed');
  assert.equal(request1.status, 502);
});

test('a tool signature and a refusal still travel with a documented terminal', async () => {
  const { raw } = await collect({
    responses: [sse([frame([{ functionCall: { name: 'probe_checkpoint', args: {} }, thoughtSignature: 'synthetic-signature' }], 'STOP')])],
    accounts: [ACCOUNTS[0]],
  });
  assert.equal(raw.choices[0].message.tool_calls[0].thought_signature, 'synthetic-signature');
  const refused = await collect({
    responses: [sse([frame([{ functionCall: { name: 'probe_checkpoint', args: {} }, thoughtSignature: 'sig' }], 'PROHIBITED_CONTENT')])],
    accounts: [ACCOUNTS[0]],
  });
  assert.equal(refused.raw.choices[0].finish_reason, 'content_filter');
  assert.equal(refused.raw.choices[0].message.tool_calls[0].thought_signature, 'sig');
});

// A provider's malformed type must not bypass validation and hit the translator's stop default.
test('non-string and empty terminal values fail JSON, SSE collection and client SSE', { timeout: 5000 }, async () => {
  for (const reason of [7, true, {}, [], ['STOP'], '']) {
    const entry = frame([{ text: 'partial' }], reason);
    for (const response of [sse([entry]), Response.json(entry)]) {
      await assert.rejects(collect({ responses: [response], accounts: [ACCOUNTS[0]] }),
        (error) => error instanceof UpstreamError && error.kind === 'terminal', String(reason));
    }
    const streamed = await collectStream({ frames: [entry], accounts: ACCOUNTS });
    assert.match(streamed.text, /upstream stream failed/);
    assert.doesNotMatch(streamed.text, /"finish_reason":"stop"/);
    assert.equal(streamed.events.filter((e) => e.event === 'attempt.timing').length, 1);
    assert.equal(streamed.events.find((e) => e.event === 'request.timing').outcome, 'failed');
  }
});
