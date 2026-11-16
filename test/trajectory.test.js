import test from 'node:test';
import assert from 'node:assert/strict';
import { TrajectoryStore, conversationKey, fnv1aInt64 } from '../src/upstream/trajectory.js';
import { openAiToAntigravity } from '../src/rewrite/openai-translate.js';

test('fnv1aInt64 is stable, signed and decimal - the CLI sessionId shape', () => {
  const a = fnv1aInt64('conversation-a');
  assert.equal(a, fnv1aInt64('conversation-a'));
  assert.notEqual(a, fnv1aInt64('conversation-b'));
  assert.match(a, /^-?\d+$/);
  // the CLI emits negative ids too; the sign is whatever the 64-bit hash lands on
  assert.ok(BigInt(a) >= -(2n ** 63n) && BigInt(a) < 2n ** 63n);
});

test('conversationKey follows the opening user turn and the model', () => {
  const base = [{ role: 'system', content: 's' }, { role: 'user', content: 'first' }];
  assert.equal(conversationKey(base, 'm'), conversationKey(base, 'm'));
  assert.notEqual(conversationKey(base, 'm'), conversationKey(base, 'other'));
  assert.notEqual(conversationKey(base, 'm'), conversationKey([{ role: 'user', content: 'second' }], 'm'));
  // a growing history keeps the same key: only the opening turn counts
  assert.equal(conversationKey([...base, { role: 'assistant', content: 'a' }], 'm'), conversationKey(base, 'm'));
});

test('a conversation keeps its cascade and session while the step advances', () => {
  const store = new TrajectoryStore();
  const first = store.begin('k');
  const second = store.begin('k');
  assert.equal(first.cascadeId, second.cascadeId);
  assert.equal(first.sessionId, second.sessionId);
  assert.notEqual(first.trajectoryId, second.trajectoryId);
  assert.equal(first.step, 0);
  assert.equal(second.step, 1);
  // a different conversation gets its own cascade
  assert.notEqual(store.begin('other').cascadeId, first.cascadeId);
});

test('entries expire after the ttl and the store stays bounded', () => {
  let now = 1_000;
  const store = new TrajectoryStore({ ttlMs: 100, maxEntries: 3, now: () => now });
  const first = store.begin('k');
  now += 101;
  assert.notEqual(store.begin('k').cascadeId, first.cascadeId);
  for (const key of ['a', 'b', 'c', 'd', 'e']) store.begin(key);
  assert.ok(store.size <= 3);
});

test('the envelope carries labels, the slash requestId and the CLI key order', () => {
  const body = openAiToAntigravity(
    { model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'low' },
    { projectId: 'p', sessionId: '-7', cascadeId: 'c-1', trajectoryId: 't-1', stepIndex: 4 },
  );
  assert.deepEqual(Object.keys(body), ['project', 'requestId', 'request', 'model', 'userAgent', 'requestType']);
  assert.equal(body.requestId, `agent/c-1/${body.requestId.split('/')[2]}/t-1/4`);
  assert.deepEqual(body.request.labels, {
    cascade_id: 'c-1',
    last_step_index: '4',
    model_enum: 'MODEL_PLACEHOLDER_M320',
    request_id: 't-1-4',
    root_cascade_id: 'c-1',
    trajectory_id: 't-1',
    used_claude: 'false',
    used_claude_conservative: 'false',
    used_non_gemini_model: 'false',
  });
  assert.equal(body.request.sessionId, '-7');
  assert.equal(body.request.systemInstruction, undefined);
});

test('claude gets the bridge shape: M35, 1024 budget, no level, claude flags', () => {
  const body = openAiToAntigravity(
    { model: 'claude-sonnet-5-5-high', messages: [{ role: 'user', content: 'hi' }] },
    { projectId: 'p', sessionId: 's', cascadeId: 'c', trajectoryId: 't' },
  );
  assert.equal(body.request.generationConfig.thinkingConfig.thinkingBudget, 1024);
  assert.equal(body.request.generationConfig.thinkingConfig.thinkingLevel, undefined);
  assert.equal(body.request.generationConfig.maxOutputTokens, 128_000);
  assert.equal(body.request.labels.model_enum, 'MODEL_PLACEHOLDER_M35');
  assert.equal(body.request.labels.used_claude, 'true');
  assert.equal(body.request.labels.used_non_gemini_model, 'true');
});

test('the live turn is wrapped and the system instruction carries the user role', () => {
  const body = openAiToAntigravity(
    {
      model: 'gemini-3.8-flash',
      messages: [
        { role: 'user', content: 'earlier' },
        { role: 'assistant', content: 'a' },
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'now' },
      ],
    },
    { projectId: 'p', sessionId: 's' },
  );
  const parts = body.request.contents.map((c) => c.parts[0].text);
  assert.equal(parts[0], 'earlier');
  assert.equal(parts[1], 'a');
  assert.match(parts[2], /^<USER_REQUEST>\nnow\n<\/USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\.\n<\/ADDITIONAL_METADATA>$/);
  assert.deepEqual(body.request.systemInstruction, { role: 'user', parts: [{ text: 'sys' }] });
});

test('the output ceiling is the model maximum, not the caller max_tokens', () => {
  const small = openAiToAntigravity(
    { model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 },
    { projectId: 'p', sessionId: 's' },
  );
  assert.equal(small.request.generationConfig.maxOutputTokens, 65_536);
  const big = openAiToAntigravity(
    { model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 90_000 },
    { projectId: 'p', sessionId: 's' },
  );
  assert.equal(big.request.generationConfig.maxOutputTokens, 90_000);
});
