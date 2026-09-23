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

// review pass 5 (2026-09-23): a value count prices a 20k-char description at one unit; referenced many
// times it froze the event loop in JSON.stringify and sent hundreds of MB upstream. The budget is output size.
test('response_format: a long string inside a def referenced many times is rejected fast', () => {
  const items = {};
  for (let r = 0; r < 300; r++) items[`r${r}`] = { $ref: '#/$defs/bomb' };
  const started = Date.now();
  assert.throws(
    () => translate(jsonSchema({ type: 'object', properties: items, $defs: { bomb: { type: 'string', description: 'x'.repeat(20_000) } } })),
    (error) => error.status === 400 && /exceeds/.test(error.message),
  );
  assert.ok(Date.now() - started < 2000);
});

test('response_format: absurd nesting is a 400, never a RangeError surfacing as 502', () => {
  let node = { type: 'string' };
  for (let i = 0; i < 20_000; i++) node = { type: 'object', properties: { n: node } };
  assert.throws(() => translate(jsonSchema({ type: 'object', properties: { a: node } })), (error) => error.status === 400 && /deep/.test(error.message));
});

test('response_format: a large legitimate flat schema (20k properties, no refs) still passes', () => {
  const properties = {};
  for (let i = 0; i < 20_000; i++) properties[`f${i}`] = { type: 'string' };
  const schema = translate(jsonSchema({ type: 'object', properties })).request.generationConfig.responseSchema;
  assert.equal(Object.keys(schema.properties).length, 20_000);
});

// review pass 6 (2026-09-23): the recursion check was O(path) per $ref and unbudgeted — a deep chain of
// long-named defs ending in a wide fan-out stalled the loop for seconds to a minute. Any shape of that
// family must now finish (either way) well under a second.
test('response_format: deep long-named ref chain with a wide fan-out stays cheap', () => {
  const $defs = {};
  const name = (i) => `${'n'.repeat(100)}${i}`;
  for (let i = 0; i < 80; i++) $defs[name(i)] = { type: 'object', properties: { next: { $ref: `#/$defs/${name(i + 1)}` } } };
  const fan = {};
  for (let r = 0; r < 2000; r++) fan[`r${r}`] = { $ref: '#/$defs/leaf' };
  $defs[name(80)] = { type: 'object', properties: fan };
  $defs.leaf = { type: 'string' };
  const started = Date.now();
  try { translate(jsonSchema({ $ref: `#/$defs/${name(0)}`, $defs })); } catch (error) { assert.equal(error.status, 400); }
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});

test('response_format: nesting just past the V8 stringify limit is a 400 from the depth cap', () => {
  let node = { type: 'string' };
  for (let i = 0; i < 1850; i++) node = { type: 'object', properties: { n: node } };
  assert.throws(() => translate(jsonSchema({ type: 'object', properties: { a: node } })), (error) => error.status === 400 && /deep/.test(error.message));
});
