import test from 'node:test';
import assert from 'node:assert/strict';
import { geminiNativeToOpenAi, antigravityToGeminiNative } from '../src/rewrite/gemini-native.js';

test('native request with systemInstruction + inlineData maps to OpenAI body', () => {
  const native = {
    systemInstruction: { parts: [{ text: 'be terse' }] },
    contents: [{
      role: 'user',
      parts: [
        { text: 'what is this' },
        { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
      ],
    }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 500 },
  };
  const openai = geminiNativeToOpenAi(native, { model: 'gemini-3.8-flash-high' });
  assert.equal(openai.model, 'gemini-3.8-flash-high');
  assert.equal(openai.messages[0].role, 'system');
  assert.equal(openai.messages[0].content, 'be terse');
  assert.equal(openai.messages[1].role, 'user');
  assert.equal(openai.messages[1].content[0].type, 'text');
  assert.equal(openai.messages[1].content[1].type, 'image_url');
  assert.match(openai.messages[1].content[1].image_url.url, /^data:image\/png;base64,AAAA$/);
  assert.equal(openai.max_tokens, 500);
  assert.equal(openai.temperature, 0.4);
});

test('google/ prefix stripped by caller via canonicalModel; native passthrough of response', () => {
  const resp = { response: { candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } } };
  const native = antigravityToGeminiNative(resp);
  assert.equal(native.candidates[0].content.parts[0].text, 'hi');
  assert.equal(native.usageMetadata.promptTokenCount, 3);
});

test('fileData video part maps to image_url placeholder (no fetch), model role maps to assistant', () => {
  const native = {
    contents: [
      { role: 'model', parts: [{ text: 'earlier' }] },
      { role: 'user', parts: [{ fileData: { fileUri: 'https://x/y.mp4', mimeType: 'video/mp4' } }, { text: 'what happens' }] },
    ],
  };
  const openai = geminiNativeToOpenAi(native, { model: 'm' });
  assert.equal(openai.messages[0].role, 'assistant');
  assert.deepEqual(openai.messages[1].content, [{ type: 'text', text: 'what happens' }]);
});
