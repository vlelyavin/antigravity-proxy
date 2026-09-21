import test from 'node:test';
import assert from 'node:assert/strict';
import { openAiToAntigravity } from '../src/rewrite/openai-translate.js';

test('OpenAI type-union schemas normalize to scalar types for google proto', () => {
  const req = openAiToAntigravity({
    model: 'gemini-3.8-flash-high',
    messages: [{ role: 'user', content: 'x' }],
    tools: [{
      type: 'function',
      function: {
        name: 'classify_media',
        description: 'classify',
        parameters: {
          type: 'object',
          properties: {
            kind: { type: ['string', 'null'], enum: ['photo', 'video', 'sticker'] },
            tags: { type: 'array', items: { type: ['string', 'null'] } },
            nested: { type: 'object', properties: { deep: { type: ['integer', 'null'] } } },
            keep: { type: 'string' },
          },
        },
      },
    }],
  }, { projectId: 'p', sessionId: 's' });

  const props = req.request.tools[0].functionDeclarations[0].parameters.properties;
  assert.equal(props.kind.type, 'string');
  assert.deepEqual(props.kind.enum, ['photo', 'video', 'sticker']);
  assert.equal(props.tags.items.type, 'string');
  assert.equal(props.nested.properties.deep.type, 'integer');
  assert.equal(props.keep.type, 'string');
});
