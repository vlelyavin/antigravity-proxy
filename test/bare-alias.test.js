import test from 'node:test';
import assert from 'node:assert/strict';
import { findModel } from '../src/rewrite/models.js';

test('bare family names resolve to medium effort (CPA compatibility)', () => {
  assert.equal(findModel('gemini-3.8-flash').id, 'gemini-3.8-flash-medium');
  assert.equal(findModel('gemini-3.1-pro').id, 'gemini-3.1-pro-high'); // pro has no medium tier
  assert.equal(findModel('claude-sonnet-4-6').id, 'claude-sonnet-4-6');
  assert.equal(findModel('gemini-3.8-flash-high').id, 'gemini-3.8-flash-high');
  assert.equal(findModel('unknown-model'), null);
});
