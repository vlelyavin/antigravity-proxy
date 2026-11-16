// Alternate wire lanes: Anthropic Messages, OpenAI Responses, OpenAI Images and a stateless MCP
// facade. All of them reuse the same execution path (`handleWithRotation`), so rotation, attempt
// timeouts, TOS blocks and scoped quota parks apply identically.

import { handleWithRotation } from './handlers.js';
import { BufferResponse, AnthropicSseResponse, ResponsesSseResponse } from './adapters.js';
import { anthropicToOpenAi, openAiToAnthropic, anthropicError, anthropicErrorFromBody } from '../rewrite/anthropic.js';
import { responsesToOpenAi, openAiToResponses, responsesError } from '../rewrite/responses.js';
import { modelsPayload } from '../rewrite/models.js';

export function jsonResponse(res, status, payload) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function run({ pool, store, upstream, config, logger, openAiBody, req, res, signal, attemptTimeoutsMs }) {
  return handleWithRotation({
    pool,
    store,
    upstream,
    config,
    logger,
    openAiBody,
    req,
    res,
    signal,
    attemptTimeoutsMs,
  });
}

/** POST /v1/messages */
export async function handleAnthropicLane(options) {
  const { body, res } = options;
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
    return jsonResponse(res, 400, anthropicError('messages must be an array', 'invalid_request_error'));
  }
  const openAiBody = anthropicToOpenAi(body);
  if (!openAiBody.model) {
    return jsonResponse(res, 400, anthropicError('model is required', 'invalid_request_error'));
  }

  if (body.stream === true) {
    const adapter = new AnthropicSseResponse(res, { model: body.model });
    try {
      await run({ ...options, openAiBody, res: adapter });
    } catch {
      if (!adapter.started) {
        return jsonResponse(res, 502, anthropicError('upstream request failed'));
      }
      adapter.onError('upstream request failed');
      if (!res.writableEnded) res.end();
      return undefined;
    }
    if (adapter.status >= 400 && !adapter.started) {
      return jsonResponse(res, adapter.status, anthropicError('upstream request failed'));
    }
    return undefined;
  }

  const buffer = new BufferResponse();
  try {
    await run({ ...options, openAiBody, res: buffer });
  } catch {
    return jsonResponse(res, 502, anthropicError('upstream request failed'));
  }
  if (buffer.status >= 400) {
    return jsonResponse(res, buffer.status, anthropicErrorFromBody(buffer.body));
  }
  let parsed;
  try {
    parsed = JSON.parse(buffer.body);
  } catch {
    return jsonResponse(res, 502, anthropicError('upstream returned malformed JSON'));
  }
  return jsonResponse(res, 200, openAiToAnthropic(parsed, { model: body.model }));
}

/** POST /v1/messages/count_tokens - a cheap estimate; no upstream call. */
export function handleAnthropicCountTokens({ body, res }) {
  const openAiBody = anthropicToOpenAi(body ?? {});
  const chars = JSON.stringify(openAiBody.messages ?? '').length;
  return jsonResponse(res, 200, { input_tokens: Math.max(1, Math.ceil(chars / 4)) });
}

/** POST /v1/responses */
export async function handleResponsesLane(options) {
  const { body, res } = options;
  if (!body || typeof body !== 'object' || body.input === undefined) {
    return jsonResponse(res, 400, responsesError('input is required', 'invalid_request_error'));
  }
  const openAiBody = responsesToOpenAi(body);
  if (!openAiBody.model) {
    return jsonResponse(res, 400, responsesError('model is required', 'invalid_request_error'));
  }

  if (body.stream === true) {
    const adapter = new ResponsesSseResponse(res, { model: body.model });
    try {
      await run({ ...options, openAiBody, res: adapter });
    } catch {
      if (!adapter.started) {
        return jsonResponse(res, 502, responsesError('upstream request failed'));
      }
      adapter.onError('upstream request failed');
      if (!res.writableEnded) res.end();
      return undefined;
    }
    if (adapter.status >= 400 && !adapter.started) {
      return jsonResponse(res, adapter.status, responsesError('upstream request failed'));
    }
    return undefined;
  }

  const buffer = new BufferResponse();
  try {
    await run({ ...options, openAiBody, res: buffer });
  } catch {
    return jsonResponse(res, 502, responsesError('upstream request failed'));
  }
  if (buffer.status >= 400) {
    let message = 'upstream request failed';
    try {
      const parsed = JSON.parse(buffer.body);
      message = parsed?.error?.message ?? message;
    } catch { /* keep the fallback */ }
    return jsonResponse(res, buffer.status, responsesError(message));
  }
  let parsed;
  try {
    parsed = JSON.parse(buffer.body);
  } catch {
    return jsonResponse(res, 502, responsesError('upstream returned malformed JSON'));
  }
  return jsonResponse(res, 200, openAiToResponses(parsed, { model: body.model }));
}

/** POST /v1/images/generations - the upstream image model returns inlineData, exposed as b64_json. */
export async function handleImagesLane(options) {
  const { body, res } = options;
  if (!body || typeof body.prompt !== 'string' || body.prompt === '') {
    return jsonResponse(res, 400, { error: { message: 'prompt is required', type: 'invalid_request_error' } });
  }
  const model = typeof body.model === 'string' && body.model !== '' ? body.model : 'gemini-3.1-flash-image';
  const openAiBody = {
    model,
    messages: [{ role: 'user', content: body.prompt }],
    max_tokens: 65_536,
  };
  const buffer = new BufferResponse();
  try {
    await run({ ...options, openAiBody, res: buffer });
  } catch {
    return jsonResponse(res, 502, { error: { message: 'upstream request failed', type: 'api_error' } });
  }
  if (buffer.status >= 400) {
    return jsonResponse(res, buffer.status, { error: { message: 'upstream request failed', type: 'api_error' } });
  }
  let parsed;
  try {
    parsed = JSON.parse(buffer.body);
  } catch {
    return jsonResponse(res, 502, { error: { message: 'upstream returned malformed JSON', type: 'api_error' } });
  }
  const images = parsed?.choices?.[0]?.message?.images ?? [];
  if (!Array.isArray(images) || images.length === 0) {
    return jsonResponse(res, 502, { error: { message: 'upstream returned no image', type: 'api_error' } });
  }
  return jsonResponse(res, 200, {
    created: Math.floor(Date.now() / 1000),
    data: images.map((image) => ({ b64_json: image.data, revised_prompt: body.prompt })),
  });
}

const MCP_TOOLS = [
  {
    name: 'ask_model',
    description: 'Ask an Antigravity model through the relay and return its text answer.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model id from list_models, e.g. gemini-3.8-flash-high' },
        prompt: { type: 'string', description: 'User prompt' },
        system: { type: 'string', description: 'Optional system instruction' },
        max_tokens: { type: 'number', description: 'Optional completion cap' },
      },
      required: ['model', 'prompt'],
    },
  },
  {
    name: 'list_models',
    description: 'List the model ids the relay serves.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function mcpAskModel(options, args) {
  if (typeof args?.model !== 'string' || typeof args?.prompt !== 'string') {
    return { content: [{ type: 'text', text: 'model and prompt are required' }], isError: true };
  }
  const messages = [];
  if (typeof args.system === 'string' && args.system !== '') messages.push({ role: 'system', content: args.system });
  messages.push({ role: 'user', content: args.prompt });
  const openAiBody = {
    model: args.model,
    messages,
    max_tokens: Number.isFinite(args.max_tokens) ? args.max_tokens : 4096,
  };
  const buffer = new BufferResponse();
  try {
    await run({ ...options, openAiBody, res: buffer });
  } catch {
    return { content: [{ type: 'text', text: 'upstream request failed' }], isError: true };
  }
  if (buffer.status >= 400) {
    return { content: [{ type: 'text', text: `upstream error (${buffer.status})` }], isError: true };
  }
  let parsed;
  try {
    parsed = JSON.parse(buffer.body);
  } catch {
    return { content: [{ type: 'text', text: 'upstream returned malformed JSON' }], isError: true };
  }
  const message = parsed?.choices?.[0]?.message ?? {};
  const text = typeof message.content === 'string' ? message.content : '';
  if (text === '') {
    return { content: [{ type: 'text', text: 'upstream returned an empty answer' }], isError: true };
  }
  return { content: [{ type: 'text', text }], isError: false };
}

/** POST /mcp - stateless JSON-RPC 2.0 (streamable HTTP without sessions). */
export async function handleMcpLane(options) {
  const { body, res } = options;
  if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return jsonResponse(res, 400, {
      jsonrpc: '2.0',
      id: body?.id ?? null,
      error: { code: -32600, message: 'invalid request' },
    });
  }
  const id = body.id ?? null;
  const reply = (result) => jsonResponse(res, 200, { jsonrpc: '2.0', id, result });
  const fail = (code, message) => jsonResponse(res, 200, { jsonrpc: '2.0', id, error: { code, message } });

  switch (body.method) {
    case 'initialize':
      return reply({
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'antigravity-proxy', version: '1.0.0' },
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      res.writeHead(202, { 'content-length': 0 });
      res.end();
      return undefined;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: MCP_TOOLS });
    case 'tools/call': {
      const name = body.params?.name;
      const args = body.params?.arguments ?? {};
      if (name === 'list_models') {
        return reply({
          content: [{ type: 'text', text: JSON.stringify(modelsPayload()) }],
          isError: false,
        });
      }
      if (name === 'ask_model') {
        const result = await mcpAskModel(options, args);
        return reply(result);
      }
      return fail(-32602, `unknown tool: ${name ?? 'missing'}`);
    }
    default:
      return fail(-32601, `method not found: ${body.method}`);
  }
}
