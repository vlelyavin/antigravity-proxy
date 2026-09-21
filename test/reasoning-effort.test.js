import test from 'node:test';
import assert from 'node:assert/strict';
import { openAiToAntigravity } from '../src/rewrite/openai-translate.js';

test('reasoning_effort overrides model-suffix thinking budget', () => {
  const base = { model: 'gemini-3.8-flash-high', messages: [{ role: 'user', content: 'hi' }] };
  const low = openAiToAntigravity({ ...base, reasoning_effort: 'low' }, { projectId: 'p', sessionId: 's' });
  assert.equal(low.request.generationConfig.thinkingConfig.thinkingBudget, 1000);

  const medium = openAiToAntigravity({ ...base, reasoning_effort: 'medium' }, { projectId: 'p', sessionId: 's' });
  assert.equal(medium.request.generationConfig.thinkingConfig.thinkingBudget, 4000);

  const high = openAiToAntigravity({ ...base, reasoning_effort: 'high' }, { projectId: 'p', sessionId: 's' });
  assert.equal(high.request.generationConfig.thinkingConfig.thinkingBudget, -1);

  // no effort -> catalog default (high model = dynamic)
  const none = openAiToAntigravity({ ...base }, { projectId: 'p', sessionId: 's' });
  assert.equal(none.request.generationConfig.thinkingConfig.thinkingBudget, -1);

  // unknown effort -> catalog default
  const weird = openAiToAntigravity({ ...base, reasoning_effort: 'ultra' }, { projectId: 'p', sessionId: 's' });
  assert.equal(weird.request.generationConfig.thinkingConfig.thinkingBudget, -1);
});

test('effort=low on a -low model keeps low budget; effort passes on pro alias too', () => {
  const base = { model: 'gemini-3.8-flash-low', messages: [{ role: 'user', content: 'hi' }] };
  const r = openAiToAntigravity({ ...base, reasoning_effort: 'high' }, { projectId: 'p', sessionId: 's' });
  assert.equal(r.request.generationConfig.thinkingConfig.thinkingBudget, -1);

  const pro = openAiToAntigravity({ model: 'gemini-3.1-pro-high', reasoning_effort: 'low', messages: [{ role: 'user', content: 'hi' }] }, { projectId: 'p', sessionId: 's' });
  assert.equal(pro.request.generationConfig.thinkingConfig.thinkingBudget, 1000);
  assert.equal(pro.model, 'gemini-pro-agent');
});
