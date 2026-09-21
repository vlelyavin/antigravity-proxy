import test from 'node:test';
import assert from 'node:assert/strict';
import { openAiToAntigravity } from '../src/rewrite/openai-translate.js';

test('anyOf in tool schemas rewrites to oneOf (Claude bridge rejects anyOf)', () => {
  const req = openAiToAntigravity({
    model: 'claude-opus-4-6-thinking',
    messages: [{ role: 'user', content: 'x' }],
    tools: [{
      type: 'function',
      function: {
        name: 't_anyof',
        description: 'test',
        parameters: {
          type: 'object',
          properties: {
            x: { description: 'v', anyOf: [{ type: 'boolean' }, { type: 'array', items: { type: 'string' } }] },
          },
        },
      },
    }],
  }, { projectId: 'p', sessionId: 's' });

  const decl = req.request.tools[0].functionDeclarations[0];
  const prop = decl.parameters.properties.x;
  assert.equal(prop.anyOf, undefined);
  assert.equal(Array.isArray(prop.oneOf), true);
  assert.deepEqual(prop.oneOf, [{ type: 'boolean' }, { type: 'array', items: { type: 'string' } }]);
});

test('bare claude alias resolves upstream id to catalog entry id', () => {
  const req = openAiToAntigravity({
    model: 'claude-opus-4-6',
    messages: [{ role: 'user', content: 'x' }],
    max_completion_tokens: 2000,
  }, { projectId: 'p', sessionId: 's' });

  // bare alias must reach upstream as the catalog id (claude-opus-4-6-thinking),
  // not the raw request name (was: upstream 404).
  assert.equal(req.model, 'claude-opus-4-6-thinking');
});

test('tool result carries tool_call_id into functionResponse.id', () => {
  const req = openAiToAntigravity({
    model: 'claude-opus-4-6-thinking',
    messages: [
      { role: 'user', content: 'call it' },
      { role: 'assistant', tool_calls: [{ id: 'call_test123', type: 'function', function: { name: 't', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_test123', name: 't', content: 'ok' },
    ],
  }, { projectId: 'p', sessionId: 's' });

  // antigravity->Claude bridge requires tool_use_id on tool_result; the
  // OpenAI tool_call_id must land on functionResponse.id.
  const parts = req.request.contents[2].parts;
  const fr = parts.find((p) => p.functionResponse).functionResponse;
  assert.equal(fr.id, 'call_test123');
  assert.deepEqual(fr.response, { result: 'ok' });
});
