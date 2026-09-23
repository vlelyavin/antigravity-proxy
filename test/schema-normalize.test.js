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

const translate = (extra) => openAiToAntigravity({
  model: 'gemini-3.8-flash-high',
  messages: [{ role: 'user', content: 'x' }],
  ...extra,
}, { projectId: 'p', sessionId: 's' });

const jsonSchema = (schema) => ({ response_format: { type: 'json_schema', json_schema: { name: 'n', strict: true, schema } } });

test('response_format keeps null unions as nullable — the upstream enforces this schema', () => {
  const gc = translate(jsonSchema({
    type: 'object',
    additionalProperties: false,
    required: ['entryId', 'actor', 'summary', 'importance'],
    properties: {
      entryId: { type: ['string', 'null'] },
      actor: { type: ['string', 'null'], enum: ['user', 'mari', 'both'] },
      summary: { type: 'string' },
      importance: { type: 'number' },
      ids: { type: ['array', 'null'], items: { type: 'string' } },
    },
  })).request.generationConfig;

  assert.equal(gc.responseMimeType, 'application/json');
  const props = gc.responseSchema.properties;
  assert.deepEqual(props.entryId, { type: 'string', nullable: true });
  assert.deepEqual(props.actor, { type: 'string', nullable: true, enum: ['user', 'mari', 'both'] });
  assert.deepEqual(props.ids, { type: 'array', nullable: true, items: { type: 'string' } });
  assert.equal(props.summary.nullable, undefined);
  assert.equal(props.importance.nullable, undefined);
});

test('response_format inlines local $refs — the upstream rejects $ref/$defs outright', () => {
  const gc = translate(jsonSchema({
    type: 'object',
    properties: {
      operations: { type: 'array', items: { $ref: '#/$defs/operation' } },
      legacy: { $ref: '#/definitions/old', description: 'kept' },
      dictionary: { type: 'object', properties: { definitions: { type: 'array', items: { type: 'string' } } } },
    },
    $defs: {
      transition: { type: 'object', properties: { kind: { type: 'string', enum: ['NEW', 'RETRACTS'] } } },
      operation: { type: 'object', properties: { cardKey: { type: ['string', 'null'] }, transition: { $ref: '#/$defs/transition' } } },
    },
    definitions: { old: { type: 'integer' } },
  })).request.generationConfig;

  const wire = JSON.stringify(gc.responseSchema);
  assert.ok(!wire.includes('$ref') && !wire.includes('$defs'), wire);
  assert.equal(gc.responseSchema.definitions, undefined);
  // a PROPERTY named "definitions" is data, not a container — it must survive
  assert.deepEqual(gc.responseSchema.properties.dictionary.properties.definitions, { type: 'array', items: { type: 'string' } });
  const op = gc.responseSchema.properties.operations.items;
  assert.deepEqual(op.properties.cardKey, { type: 'string', nullable: true });
  assert.deepEqual(op.properties.transition.properties.kind.enum, ['NEW', 'RETRACTS']);
  assert.deepEqual(gc.responseSchema.properties.legacy, { type: 'integer', description: 'kept' });
});

test('response_format translation never mutates the caller body — the vertex fallback forwards it verbatim', () => {
  const body = jsonSchema({
    type: 'object',
    properties: { a: { $ref: '#/$defs/a' }, b: { type: ['string', 'null'] } },
    $defs: { a: { type: ['integer', 'null'] } },
  });
  const before = structuredClone(body);
  translate(body);
  assert.deepEqual(body, before);
});

test('response_format rejects unresolvable and self-recursive $refs with a 400', () => {
  for (const schema of [
    { type: 'object', properties: { a: { $ref: '#/$defs/missing' } } },
    { type: 'object', properties: { a: { $ref: 'https://example.com/schema.json' } } },
    { $defs: { node: { type: 'object', properties: { next: { $ref: '#/$defs/node' } } } }, $ref: '#/$defs/node' },
  ]) {
    assert.throws(() => translate(jsonSchema(schema)), (error) => error.status === 400 && /response_format/.test(error.message));
  }
});

test('json_object sets only the mime type; tool declarations keep the plain collapse', () => {
  const gc = translate({ response_format: { type: 'json_object' } }).request.generationConfig;
  assert.equal(gc.responseMimeType, 'application/json');
  assert.equal(gc.responseSchema, undefined);

  const decl = translate({
    tools: [{ type: 'function', function: { name: 't', parameters: { type: 'object', properties: { e: { type: ['string', 'null'] } } } } }],
  }).request.tools[0].functionDeclarations[0];
  assert.deepEqual(decl.parameters.properties.e, { type: 'string' });
});

// review P1/P2 (2026-09-23): a def referencing the next one twice grows 2^depth — must be a fast 400,
// never an OOM; a long linear chain without a cycle is legal and must inline.
const chain = (levels, refsPerLevel) => {
  const $defs = {};
  for (let i = 0; i < levels; i++) {
    const properties = {};
    for (let r = 0; r < refsPerLevel; r++) properties[`p${r}`] = { $ref: `#/$defs/d${i + 1}` };
    $defs[`d${i}`] = { type: 'object', properties };
  }
  $defs[`d${levels}`] = { type: 'string' };
  return { $ref: '#/$defs/d0', $defs };
};

test('response_format: exponential $ref DAG is rejected fast instead of exhausting memory', () => {
  const started = Date.now();
  assert.throws(() => translate(jsonSchema(chain(40, 2))), (error) => error.status === 400 && /exceeds/.test(error.message));
  assert.ok(Date.now() - started < 2000, 'budget must stop the expansion early');
});

test('response_format: a 40-deep linear $ref chain is legal and inlines', () => {
  let node = translate(jsonSchema(chain(40, 1))).request.generationConfig.responseSchema;
  for (let i = 0; i < 40; i++) node = node.properties.p0;
  assert.deepEqual(node, { type: 'string' });
});

test('response_format: an indirect cycle between two defs is a 400', () => {
  const schema = {
    type: 'object',
    properties: { a: { $ref: '#/$defs/x' } },
    $defs: { x: { type: 'object', properties: { y: { $ref: '#/$defs/y' } } }, y: { type: 'object', properties: { x: { $ref: '#/$defs/x' } } } },
  };
  assert.throws(() => translate(jsonSchema(schema)), (error) => error.status === 400 && /recursive/.test(error.message));
});

// review pass 4 (2026-09-23): a fat def referenced many times stays inside a resolution budget but
// multiplies the OUTPUT (30k props × 1000 refs OOM'd, 5k × 1000 froze the event loop 7 s).
test('response_format: a fat def referenced many times is rejected fast, not inlined into gigabytes', () => {
  const properties = {};
  for (let i = 0; i < 5000; i++) properties[`f${i}`] = { type: 'string' };
  const items = {};
  for (let r = 0; r < 1000; r++) items[`r${r}`] = { $ref: '#/$defs/fat' };
  const started = Date.now();
  assert.throws(
    () => translate(jsonSchema({ type: 'object', properties: items, $defs: { fat: { type: 'object', properties } } })),
    (error) => error.status === 400 && /exceeds/.test(error.message),
  );
  assert.ok(Date.now() - started < 2000, 'the value budget must stop the copy early');
});
