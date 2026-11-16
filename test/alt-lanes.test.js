import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { loadConfig } from '../src/config/load-config.js';
import { createLogger } from '../src/utils/logger.js';
import { CredentialStore } from '../src/credentials/credential-store.js';
import { UpstreamClient, generationOf } from '../src/upstream/upstream-client.js';
import { AccountPool } from '../src/upstream/account-pool.js';
import { createServer } from '../src/server/create-server.js';
import { anthropicToOpenAi, openAiToAnthropic } from '../src/rewrite/anthropic.js';
import { responsesToOpenAi, openAiToResponses } from '../src/rewrite/responses.js';
import { AnthropicSseResponse } from '../src/server/adapters.js';

const CONFIG = loadConfig({ env: { ANTIGRAVITY_PROXY_CONFIG: 'test/fixtures/empty-config.json', ANTIGRAVITY_PROXY_PORT: '0', ANTIGRAVITY_PROXY_LOG_LEVEL: 'error' } });

function fakeUpstream() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      if (parsed.trajectoryId) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      const prompt = parsed.request?.contents?.[0]?.parts?.[0]?.text ?? '';
      if (!req.url.includes('streamGenerateContent')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'pong' }] }, finishReason: 'STOP' }] } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (prompt.includes('DRAW')) {
        res.write(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 0, totalTokenCount: 3 } } })}\n\n`);
        res.end();
        return;
      }
      res.write(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'he' }] } }] } })}\n\n`);
      res.write(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'y' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 } } })}\n\n`);
      res.end();
    });
  });
}

async function startStack({ accounts } = {}) {
  const upstreamServer = fakeUpstream();
  await once(upstreamServer.listen(0), 'listening');
  const upstreamPort = upstreamServer.address().port;
  const logger = createLogger('error');
  const store = new CredentialStore({ searchPaths: [], logger });
  store.readAll = () => accounts;
  const config = {
    ...CONFIG,
    upstream: { ...CONFIG.upstream, baseUrl: `http://127.0.0.1:${upstreamPort}`, apiVersion: 'v1internal', eagerRefreshMs: 0, egress: { url: null } },
    apiKey: null,
  };
  const upstreamClient = new UpstreamClient({ currentGeneration: generationOf, config, logger });
  upstreamClient.accessToken = async () => 'test-token';
  const pool = new AccountPool({ logger });
  const server = createServer({ config, credentialStore: store, upstream: upstreamClient, pool, logger });
  await once(server.listen(0), 'listening');
  return { server, upstreamServer, port: server.address().port };
}

const ACCOUNT = { generation: 'synthetic', id: 'alt1', email: 'a@x', projectId: 'p', refreshToken: 'r', accessToken: 't', expiry: null };

function post(port, path, body) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('anthropic request maps system, tool_result, tools and thinking', () => {
  const openAi = anthropicToOpenAi({
    model: 'gemini-3.8-flash-high',
    max_tokens: 100,
    system: [{ type: 'text', text: 'be brief' }],
    thinking: { type: 'enabled', budget_tokens: 9000 },
    tools: [{ name: 'get', description: 'd', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }],
    tool_choice: { type: 'any' },
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get', input: { q: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '42' }, { type: 'text', text: 'thanks' }] },
    ],
  });
  assert.equal(openAi.max_tokens, 100);
  assert.equal(openAi.reasoning_effort, 'high');
  assert.equal(openAi.tool_choice, 'required');
  assert.equal(openAi.tools[0].function.name, 'get');
  assert.deepEqual(openAi.messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'user']);
  assert.equal(openAi.messages[2].tool_calls[0].id, 'toolu_1');
  assert.equal(openAi.messages[3].tool_call_id, 'toolu_1');
});

test('anthropic response carries text and tool_use blocks', () => {
  const message = openAiToAnthropic({
    id: 'chatcmpl-abc',
    choices: [{ message: { content: 'hello', tool_calls: [{ id: 'call_1', function: { name: 'f', arguments: '{"a":1}' } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 5, completion_tokens: 7 },
  }, { model: 'm' });
  assert.equal(message.type, 'message');
  assert.equal(message.content[0].text, 'hello');
  assert.equal(message.content[1].type, 'tool_use');
  assert.deepEqual(message.content[1].input, { a: 1 });
  assert.equal(message.stop_reason, 'tool_use');
  assert.equal(message.usage.output_tokens, 7);
});

test('anthropic SSE adapter emits the message lifecycle', () => {
  const chunks = [];
  const fakeRes = {
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(value) { chunks.push(value); return true; },
    end() { this.writableEnded = true; },
  };
  const adapter = new AnthropicSseResponse(fakeRes, { model: 'm' });
  adapter.writeHead(200, {});
  adapter.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'he' }, finish_reason: null }] })}\n\n`);
  adapter.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'y' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2 } })}\n\n`);
  adapter.write('data: [DONE]\n\n');
  adapter.end();
  const text = chunks.join('');
  assert.match(text, /event: message_start/);
  assert.match(text, /event: content_block_delta/);
  assert.match(text, /"text_delta"/);
  assert.match(text, /event: message_delta/);
  assert.match(text, /"stop_reason":"end_turn"/);
  assert.match(text, /event: message_stop/);
  assert.equal(text.includes('[DONE]'), false);
});

test('responses request maps instructions, function output and tools', () => {
  const openAi = responsesToOpenAi({
    model: 'm',
    instructions: 'sys',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'function_call_output', call_id: 'call_1', output: '42' },
    ],
    tools: [{ type: 'function', name: 'f', description: 'd', parameters: { type: 'object' } }],
    max_output_tokens: 50,
    reasoning: { effort: 'low' },
  });
  assert.deepEqual(openAi.messages.map((m) => m.role), ['system', 'user', 'tool']);
  assert.equal(openAi.tools[0].function.name, 'f');
  assert.equal(openAi.max_tokens, 50);
  assert.equal(openAi.reasoning_effort, 'low');
});

test('responses answer carries output_text and usage', () => {
  const response = openAiToResponses({
    id: 'chatcmpl-x',
    choices: [{ message: { content: 'hey' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  }, { model: 'm' });
  assert.equal(response.object, 'response');
  assert.equal(response.status, 'completed');
  assert.equal(response.output[0].type, 'message');
  assert.equal(response.output[0].content[0].text, 'hey');
  assert.equal(response.usage.total_tokens, 4);
});

test('POST /v1/messages non-stream answers in the Anthropic shape', async () => {
  const stack = await startStack({ accounts: [ACCOUNT] });
  try {
    const res = await post(stack.port, '/v1/messages', { model: 'gemini-3.8-flash-high', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.type, 'message');
    assert.equal(json.content[0].text, 'hey');
    assert.equal(json.stop_reason, 'end_turn');
  } finally {
    stack.server.close(); stack.upstreamServer.close();
  }
});

test('POST /v1/messages stream answers in Anthropic SSE', async () => {
  const stack = await startStack({ accounts: [ACCOUNT] });
  try {
    const res = await post(stack.port, '/v1/messages', { model: 'gemini-3.8-flash-high', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /event: message_start/);
    assert.match(text, /"text":"he"/);
    assert.match(text, /event: message_stop/);
  } finally {
    stack.server.close(); stack.upstreamServer.close();
  }
});

test('POST /v1/messages/count_tokens returns an estimate', async () => {
  const stack = await startStack({ accounts: [ACCOUNT] });
  try {
    const res = await post(stack.port, '/v1/messages/count_tokens', { model: 'm', messages: [{ role: 'user', content: 'hello world' }] });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(json.input_tokens > 0);
  } finally {
    stack.server.close(); stack.upstreamServer.close();
  }
});

test('POST /v1/responses answers in the Responses shape', async () => {
  const stack = await startStack({ accounts: [ACCOUNT] });
  try {
    const res = await post(stack.port, '/v1/responses', { model: 'gemini-3.8-flash-high', input: 'hi', max_output_tokens: 50 });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.object, 'response');
    assert.equal(json.status, 'completed');
    assert.match(JSON.stringify(json.output), /hey/);
  } finally {
    stack.server.close(); stack.upstreamServer.close();
  }
});

test('POST /v1/responses stream emits response.completed', async () => {
  const stack = await startStack({ accounts: [ACCOUNT] });
  try {
    const res = await post(stack.port, '/v1/responses', { model: 'gemini-3.8-flash-high', input: 'hi', stream: true });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /event: response\.created/);
    assert.match(text, /event: response\.output_text\.delta/);
    assert.match(text, /event: response\.completed/);
  } finally {
    stack.server.close(); stack.upstreamServer.close();
  }
});

test('POST /v1/images/generations returns b64_json from inlineData', async () => {
  const stack = await startStack({ accounts: [ACCOUNT] });
  try {
    const res = await post(stack.port, '/v1/images/generations', { model: 'gemini-3.1-flash-image', prompt: 'DRAW a dot' });
    const body = await res.text();
    assert.equal(res.status, 200, body);
    const json = JSON.parse(body);
    assert.equal(json.data[0].b64_json, 'iVBORw0KGgo=');
  } finally {
    stack.server.close(); stack.upstreamServer.close();
  }
});

test('MCP facade answers initialize, tools/list and tools/call', async () => {
  const stack = await startStack({ accounts: [ACCOUNT] });
  try {
    const init = await post(stack.port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(init.status, 200);
    const initJson = await init.json();
    assert.equal(initJson.result.serverInfo.name, 'antigravity-proxy');

    const list = await post(stack.port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const listJson = await list.json();
    assert.deepEqual(listJson.result.tools.map((t) => t.name), ['ask_model', 'list_models']);

    const models = await post(stack.port, '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_models', arguments: {} } });
    const modelsJson = await models.json();
    assert.match(modelsJson.result.content[0].text, /gemini-3\.8-flash-high/);

    const ask = await post(stack.port, '/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ask_model', arguments: { model: 'gemini-3.8-flash-high', prompt: 'hi' } } });
    const askJson = await ask.json();
    assert.equal(askJson.result.content[0].text, 'hey');
    assert.equal(askJson.result.isError, false);
  } finally {
    stack.server.close(); stack.upstreamServer.close();
  }
});
