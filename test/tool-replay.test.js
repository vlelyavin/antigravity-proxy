import test from 'node:test';
import assert from 'node:assert/strict';
import { openAiToAntigravity } from '../src/rewrite/openai-translate.js';

const functionResponse = (r) => {
  for (const c of r.request.contents) for (const p of c.parts ?? []) if (p.functionResponse) return p.functionResponse;
  return null;
};
const mk = (messages) => openAiToAntigravity({ model: 'gemini-3.8-flash', messages }, { projectId: 'p', sessionId: 's' });

test('functionResponse.name resolves from the assistant tool_calls when the tool message has no name', () => {
  const r = mk([
    { role: 'user', content: 'compute' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'calc', arguments: '{"expr":"1+1"}' } }] },
    { role: 'tool', tool_call_id: 'call_abc', content: '2' },
  ]);
  const fr = functionResponse(r);
  assert.ok(fr, 'functionResponse missing');
  assert.equal(fr.name, 'calc');
  assert.equal(fr.response.result, '2');
});

test('an explicit tool name wins; an unknown id falls back to the id', () => {
  const nameFor = (toolMsg) => functionResponse(mk([
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'calc', arguments: '{}' } }] },
    toolMsg,
  ])).name;
  assert.equal(nameFor({ role: 'tool', tool_call_id: 'c1', name: 'explicit', content: 'x' }), 'explicit');
  assert.equal(nameFor({ role: 'tool', tool_call_id: 'zzz', content: 'x' }), 'zzz');
});
