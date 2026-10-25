import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { loadConfig } from '../src/config/load-config.js';
import { createLogger } from '../src/utils/logger.js';
import { AccountPool } from '../src/upstream/account-pool.js';
import { UpstreamClient, UpstreamError } from '../src/upstream/upstream-client.js';
import { createServer } from '../src/server/create-server.js';
import { handleWithRotation } from '../src/server/handlers.js';

const CONFIG = loadConfig({ env: { ANTIGRAVITY_PROXY_PORT: '0', ANTIGRAVITY_PROXY_LOG_LEVEL: 'error' } });

const ACCOUNTS = [
  { id: 'a0', email: 'first@example.com' },
  { id: 'a1', email: 'second@example.com' },
];
const CONFIG_NO_FALLBACK = {
  apiKey: null,
  upstream: { requestTimeoutMs: 2000, egress: { url: null } },
  rotation: { cooldownMs: 45_000 },
  fallback: { enabled: false },
};
const BODY = { model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'synthetic' }], stream: false };

const frame = (parts, finishReason) => ({ response: { candidates: [{ content: { parts }, ...(finishReason ? { finishReason } : {}) }] } });

function recorder() {
  const events = [];
  const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((level) => [
    level, (event, data = {}) => events.push({ level, event, ...data }),
  ]));
  return { logger, events };
}

function sseResponse(frames, { chunkSize = 0, trailingBreak = true } = {}) {
  let raw = frames.map((entry) => `data: ${typeof entry === 'string' ? entry : JSON.stringify(entry)}\n\n`).join('');
  if (!trailingBreak) raw = raw.replace(/\n\n$/, '');
  const bytes = new TextEncoder().encode(raw);
  const chunks = [];
  if (chunkSize > 0) {
    for (let i = 0; i < bytes.length; i += chunkSize) chunks.push(bytes.slice(i, i + chunkSize));
  } else {
    chunks.push(bytes);
  }
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

/**
 * Runs one non-stream request with a synthetic upstream, so the collector sees exactly the frames
 * a real generation would send. `responses` gives each call its own frame list (rotation tests).
 */
async function collect({ frames = [], responses = null, json = null, chunkSize = 0, trailingBreak = true, accounts = ACCOUNTS, attemptTimeoutsMs = [] } = {}) {
  const { logger, events } = recorder();
  const pool = new AccountPool({ logger });
  let call = 0;
  const upstream = {
    invalidate() {},
    async generateStream() {
      if (json) return Response.json(json);
      const next = responses ? responses[call++] : frames;
      return sseResponse(next, { chunkSize, trailingBreak });
    },
  };
  let raw = null;
  const res = {
    headersSent: false,
    writeHead() { this.headersSent = true; },
    end(value) { raw = JSON.parse(value); },
  };
  await handleWithRotation({
    pool, store: { readAll: () => accounts }, upstream, config: CONFIG_NO_FALLBACK, logger, openAiBody: BODY, res, signal: null, attemptTimeoutsMs,
  });
  return { raw, pool, events };
}

test('thought signatures and tool arguments survive the non-stream collection', async () => {
  const { raw } = await collect({
    frames: [frame([{ functionCall: { name: 'probe_checkpoint', args: { n: 1 } }, thoughtSignature: 'synthetic-signature' }], 'STOP')],
  });
  const call = raw.choices[0].message.tool_calls[0];
  assert.equal(raw.choices[0].finish_reason, 'stop');
  assert.equal(call.thought_signature, 'synthetic-signature');
  assert.equal(call.type, 'function');
  assert.equal(call.function.name, 'probe_checkpoint');
  assert.equal(call.function.arguments, '{"n":1}', 'tool arguments stay byte-for-byte');
  assert.match(call.id, /^call_/);
});

test('a prompt-level block keeps its refusal and content_filter finish reason', async () => {
  const { raw } = await collect({ frames: [{ response: { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } } }] });
  assert.equal(raw.choices[0].message.refusal, 'PROHIBITED_CONTENT');
  assert.equal(raw.choices[0].finish_reason, 'content_filter');
});

test('a stream that ends without a terminal frame is a failure, not a fabricated stop', async () => {
  await assert.rejects(
    collect({ frames: [frame([{ text: 'unfinished fragment' }])] }),
    (error) => error instanceof UpstreamError && error.status === 502 && /finish reason/.test(error.message),
  );
});

test('plain JSON on the SSE endpoint requires a terminal candidate or a prompt refusal', async () => {
  for (const json of [{}, frame([{ text: 'unfinished fragment' }])]) {
    await assert.rejects(collect({ json }), (error) => error instanceof UpstreamError && error.kind === 'truncated');
  }
  const terminal = await collect({ json: frame([{ text: 'complete' }], 'STOP') });
  assert.equal(terminal.raw.choices[0].message.content, 'complete');
  const refused = await collect({ json: { response: { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } } } });
  assert.equal(refused.raw.choices[0].message.refusal, 'PROHIBITED_CONTENT');
});

test('an explicit upstream error frame rotates to the next account instead of succeeding', async () => {
  const { raw, pool, events } = await collect({
    responses: [
      [{ error: { code: 429, message: 'quota exceeded', status: 'RESOURCE_EXHAUSTED' } }],
      [frame([{ text: 'second account' }], 'STOP')],
    ],
  });
  assert.equal(raw.choices[0].message.content, 'second account');
  assert.deepEqual(pool.healthy(ACCOUNTS).map((a) => a.id), ['a1'], 'the erroring account sits out its cooldown');
  assert.ok(events.some((e) => e.event === 'rotation.quota'));
});

test('a malformed frame is a protocol failure, not a silently skipped line', async () => {
  await assert.rejects(
    collect({ frames: ['{not json', frame([{ text: 'ignored' }], 'STOP')] }),
    (error) => error instanceof UpstreamError && error.status === 502 && /malformed/.test(error.message),
  );
});

test('an error body on the streaming endpoint is not an empty completion', async () => {
  const { logger } = recorder();
  const upstream = {
    invalidate() {},
    async generateStream() {
      return new Response(JSON.stringify({ error: { code: 503, message: 'backend busy', status: 'UNAVAILABLE' } }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  const res = { headersSent: false, writeHead() { this.headersSent = true; }, end() {} };
  await assert.rejects(
    handleWithRotation({
      pool: new AccountPool({ logger }), store: { readAll: () => [ACCOUNTS[0]] }, upstream,
      config: CONFIG_NO_FALLBACK, logger, openAiBody: BODY, res, signal: null,
    }),
    (error) => error instanceof UpstreamError && error.status === 502 && /UNAVAILABLE|backend busy/.test(error.message),
  );
});

test('content, reasoning and finish reasons are stitched exactly across chunk boundaries', async () => {
  const long = 'ответ '.repeat(40);
  const { raw } = await collect({
    frames: [
      frame([{ text: 'he' }]),
      frame([{ text: 'y', thought: false }, { text: 'thinking', thought: true }]),
      frame([{ text: long }], 'MAX_TOKENS'),
    ],
    chunkSize: 7, // frames split across TCP chunks, mid-line and mid-JSON
  });
  assert.equal(raw.choices[0].message.content, `hey${long}`);
  assert.equal(raw.choices[0].message.reasoning_content, 'thinking');
  assert.equal(raw.choices[0].finish_reason, 'length', 'an explicit MAX_TOKENS is preserved');
});

test('a final frame without a trailing newline is still read', async () => {
  const { raw } = await collect({
    frames: [frame([{ text: 'tail' }], 'STOP')],
    trailingBreak: false,
  });
  assert.equal(raw.choices[0].message.content, 'tail');
  assert.equal(raw.choices[0].finish_reason, 'stop');
});

test('several tool calls keep their order and their own arguments', async () => {
  const { raw } = await collect({
    frames: [frame([
      { functionCall: { name: 'first', args: { a: 1 } }, thoughtSignature: 'sig-1' },
      { functionCall: { name: 'second', args: { b: [1, 2] } }, thoughtSignature: 'sig-2' },
    ], 'STOP')],
  });
  const calls = raw.choices[0].message.tool_calls;
  assert.deepEqual(calls.map((call) => call.function.name), ['first', 'second']);
  assert.deepEqual(calls.map((call) => call.function.arguments), ['{"a":1}', '{"b":[1,2]}']);
  assert.deepEqual(calls.map((call) => call.thought_signature), ['sig-1', 'sig-2']);
});

test('the native vision lane still answers with the google-native body, untouched by the collector', async () => {
  const logger = createLogger('error');
  const native = {
    response: {
      candidates: [{ content: { parts: [{ text: 'a red square' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
    },
  };
  const calls = [];
  const upstream = new UpstreamClient({
    config: { ...CONFIG, upstream: { ...CONFIG.upstream, baseUrl: 'http://127.0.0.1:1', egress: { url: null } } },
    logger,
  });
  upstream.accessToken = async () => 'test-token';
  upstream.generate = async ({ openAiBody, account }) => {
    calls.push({ account, model: openAiBody.model });
    return { ok: true, json: async () => native };
  };
  const server = createServer({
    config: { ...CONFIG, fallback: { enabled: false } },
    credentialStore: { readAll: () => [{ id: 'a0', projectId: 'p' }] },
    upstream,
    pool: new AccountPool({ logger }),
    logger,
  });
  await once(server.listen(0), 'listening');
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1beta/models/gemini-3.8-flash:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [{ text: 'what is this' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }],
        }],
      }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), native.response, 'the google-native body crosses the lane unchanged');
    assert.equal(calls.length, 1);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('the streaming lane turns an upstream error frame into an error frame, not a clean finish', async () => {
  const logger = createLogger('error');
  const upstreamServer = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(frame([{ text: 'partial' }]))}\n\n`);
      res.end(`data: ${JSON.stringify({ error: { code: 500, message: 'backend gave up', status: 'INTERNAL' } })}\n\n`);
    });
  });
  await once(upstreamServer.listen(0), 'listening');
  const client = new UpstreamClient({
    config: {
      ...CONFIG,
      upstream: { ...CONFIG.upstream, baseUrl: `http://127.0.0.1:${upstreamServer.address().port}`, apiVersion: 'v1internal', requestTimeoutMs: 2000, egress: { url: null } },
    },
    logger,
  });
  client.accessToken = async () => 'test-token';
  const server = createServer({
    config: { ...CONFIG, fallback: { enabled: false } },
    credentialStore: { readAll: () => [{ id: 'a0', projectId: 'p' }] },
    upstream: client,
    pool: new AccountPool({ logger }),
    logger,
  });
  await once(server.listen(0), 'listening');
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-3.8-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /"content":"partial"/);
    assert.match(text, /upstream stream failed/);
    assert.match(text, /\[DONE\]/);
  } finally {
    server.closeAllConnections();
    server.close();
    upstreamServer.closeAllConnections();
    upstreamServer.close();
  }
});
