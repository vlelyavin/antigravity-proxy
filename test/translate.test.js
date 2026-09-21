import test from 'node:test';
import assert from 'node:assert/strict';
import { openAiToAntigravity, antigravityToOpenAi, antigravityChunkToOpenAiChunk } from '../src/rewrite/openai-translate.js';
import { modelsPayload } from '../src/rewrite/models.js';

test('simple user message maps to contents with user role', () => {
  const body = openAiToAntigravity(
    { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'ping' }] },
    { projectId: 'proj', sessionId: '-123' },
  );
  assert.equal(body.request.contents[0].role, 'user');
  assert.equal(body.request.contents[0].parts[0].text, 'ping');
  assert.equal(body.model, 'gemini-3.8-flash-high');
  assert.equal(body.project, 'proj');
  assert.equal(body.userAgent, 'antigravity');
  assert.equal(body.requestType, 'agent');
  assert.ok(body.requestId.startsWith('agent-'));
  assert.equal(body.request.sessionId, '-123');
});

test('system messages collapse into systemInstruction', () => {
  const body = openAiToAntigravity(
    { messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi' }] },
    { projectId: 'p', sessionId: '-1' },
  );
  assert.equal(body.request.systemInstruction.parts[0].text, 'be terse');
  assert.equal(body.request.contents.length, 1);
});

test('assistant message maps to model role; tool calls map to functionCall parts', () => {
  const body = openAiToAntigravity(
    {
      messages: [
        { role: 'user', content: 'list files' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{"path":"/"}' } }] },
        { role: 'tool', tool_call_id: 'c1', name: 'ls', content: 'a,b' },
      ],
    },
    { projectId: 'p', sessionId: '-1' },
  );
  assert.equal(body.request.contents[1].role, 'model');
  assert.deepEqual(body.request.contents[1].parts[0].functionCall, { name: 'ls', args: { path: '/' }, id: 'c1' });
  assert.equal(body.request.contents[1].parts[0].thoughtSignature, 'skip_thought_signature_validator');
  assert.equal(body.request.contents[2].role, 'user');
  assert.equal(body.request.contents[2].parts[0].functionResponse.response.result, 'a,b');
});

test('generation params carry over', () => {
  const body = openAiToAntigravity(
    { messages: [{ role: 'user', content: 'x' }], max_tokens: 100, temperature: 0.5, top_p: 0.9, stop: ['END'] },
    { projectId: 'p', sessionId: '-1' },
  );
  assert.equal(body.request.generationConfig.maxOutputTokens, 100);
  assert.equal(body.request.generationConfig.temperature, 0.5);
  assert.equal(body.request.generationConfig.topP, 0.9);
  assert.deepEqual(body.request.generationConfig.stopSequences, ['END']);
});

test('tools map to functionDeclarations', () => {
  const body = openAiToAntigravity(
    {
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }],
    },
    { projectId: 'p', sessionId: '-1' },
  );
  assert.deepEqual(body.request.tools, [{ functionDeclarations: [{ name: 'f', description: 'd', parameters: { type: 'object' } }] }]);
});

test('data-url image maps to inlineData', () => {
  const body = openAiToAntigravity(
    {
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ] }],
    },
    { projectId: 'p', sessionId: '-1' },
  );
  assert.deepEqual(body.request.contents[0].parts[1], { inlineData: { mimeType: 'image/png', data: 'AAAA' } });
});

test('response maps back to openai shape', () => {
  const out = antigravityToOpenAi(
    { response: { candidates: [{ content: { parts: [{ text: 'pong' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } } },
    { model: 'gemini-3.8-flash-high' },
  );
  assert.equal(out.choices[0].message.content, 'pong');
  assert.equal(out.choices[0].finish_reason, 'stop');
  assert.equal(out.usage.prompt_tokens, 5);
});

test('functionCall in response becomes tool_calls', () => {
  const out = antigravityToOpenAi(
    { response: { candidates: [{ content: { parts: [{ functionCall: { name: 'ls', args: { path: '/' } } }] }, finishReason: 'STOP' }] } },
    { model: 'm' },
  );
  assert.equal(out.choices[0].message.tool_calls[0].function.name, 'ls');
  assert.deepEqual(JSON.parse(out.choices[0].message.tool_calls[0].function.arguments), { path: '/' });
});

test('stream chunk with text becomes a delta chunk', () => {
  const indexRef = { count: 0, first: true };
  const chunk = antigravityChunkToOpenAiChunk(
    { response: { candidates: [{ content: { parts: [{ text: 'he' }] } }] } },
    { model: 'm', indexRef },
  );
  assert.deepEqual(chunk.choices[0].delta, { role: 'assistant', content: 'he' });
  const chunk2 = antigravityChunkToOpenAiChunk(
    { response: { candidates: [{ content: { parts: [{ text: 'y' }] } }] } },
    { model: 'm', indexRef },
  );
  assert.deepEqual(chunk2.choices[0].delta, { content: 'y' });
});

test('final stream chunk carries usage and finish_reason', () => {
  const indexRef = { count: 0, first: true };
  const chunk = antigravityChunkToOpenAiChunk(
    { response: { candidates: [{ content: {}, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, thoughtsTokenCount: 5, totalTokenCount: 12 } } },
    { model: 'm', indexRef },
  );
  assert.equal(chunk.choices[0].finish_reason, 'stop');
  assert.equal(chunk.usage.completion_tokens, 9);
});

test('models payload lists the antigravity catalog', () => {
  const payload = modelsPayload();
  assert.ok(payload.data.some((m) => m.id === 'gemini-3.8-flash-high'));
  assert.ok(payload.data.some((m) => m.id === 'claude-sonnet-4-6'));
});
