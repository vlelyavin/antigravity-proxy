import test from 'node:test';
import assert from 'node:assert/strict';
import { openAiToAntigravity } from '../src/rewrite/openai-translate.js';

const mk = (model, extra = {}) => openAiToAntigravity(
  { model, messages: [{ role: 'user', content: 'hi' }], ...extra },
  { projectId: 'p', sessionId: 's' },
);

test('effort maps to thinkingLevel and the suffixed upstream id; no thinkingBudget', () => {
  const low = mk('gemini-3.8-flash', { reasoning_effort: 'low' });
  assert.equal(low.model, 'gemini-3.8-flash-low');
  assert.equal(low.request.generationConfig.thinkingConfig.thinkingLevel, 'low');
  assert.equal(low.request.generationConfig.thinkingConfig.thinkingBudget, undefined);
  assert.equal(low.request.generationConfig.thinkingConfig.includeThoughts, true);

  assert.equal(mk('gemini-3.8-flash', { reasoning_effort: 'medium' }).request.generationConfig.thinkingConfig.thinkingLevel, 'medium');
  assert.equal(mk('gemini-3.8-flash', { reasoning_effort: 'high' }).request.generationConfig.thinkingConfig.thinkingLevel, 'high');

  for (const e of ['xhigh', 'ultra', 'max']) {
    assert.equal(mk('gemini-3.8-flash', { reasoning_effort: e }).request.generationConfig.thinkingConfig.thinkingLevel, 'high', `effort=${e}`);
  }
  for (const e of ['none', 'minimal', 'off']) {
    assert.equal(mk('gemini-3.8-flash', { reasoning_effort: e }).request.generationConfig.thinkingConfig.thinkingLevel, 'low', `effort=${e}`);
  }
  // owner rule: reasoning disabled behaves like low
  assert.equal(mk('gemini-3.8-flash', { reasoning: { enabled: false } }).request.generationConfig.thinkingConfig.thinkingLevel, 'low');
  // no effort -> no level (provider default)
  assert.equal(mk('gemini-3.8-flash').request.generationConfig.thinkingConfig.thinkingLevel, undefined);
});

test('effort overrides the requested suffix; pro alias resolves', () => {
  assert.equal(mk('gemini-3.8-flash-low', { reasoning_effort: 'high' }).model, 'gemini-3.8-flash-high');
  assert.equal(mk('gemini-3.1-pro-high').model, 'gemini-pro-agent');
  assert.equal(mk('gemini-3.1-pro-high', { reasoning_effort: 'low' }).model, 'gemini-3.1-pro-low');
});
