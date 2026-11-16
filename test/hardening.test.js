import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openAiToAntigravity } from '../src/rewrite/openai-translate.js';
import { findModel, MODEL_CATALOG } from '../src/rewrite/models.js';
import { scrubIdentity } from '../src/rewrite/identity-scrub.js';
import { upstreamErrorFrom, describeFailure } from '../src/upstream/failure.js';
import { decideFailure } from '../src/upstream/rotation-policy.js';
import { AccountPool } from '../src/upstream/account-pool.js';

test('identity scrub removes harness markers from the system instruction', () => {
  const body = openAiToAntigravity({
    model: 'gemini-3.8-flash-high',
    messages: [
      { role: 'system', content: 'You are Hermes, an agent by Nous Research. You drive Claude Code.' },
      { role: 'user', content: 'hi' },
    ],
  }, { projectId: 'p', sessionId: 's' });
  const text = body.request.systemInstruction.parts[0].text;
  for (const marker of ['Hermes', 'Nous Research', 'Claude Code', 'Anthropic']) {
    assert.equal(text.includes(marker), false, marker);
  }
  assert.ok(text.includes('the assistant'));
  assert.ok(text.includes('the model provider'));
});

test('identity scrub can be disabled and extended', () => {
  assert.equal(scrubIdentity('Hermes is here', { enabled: false }), 'Hermes is here');
  assert.equal(scrubIdentity('Hermes is here'), 'the assistant is here');
  assert.equal(scrubIdentity('my-hermes-wrapper stays', {}), 'my-hermes-wrapper stays');
  assert.equal(scrubIdentity('VovaCorp rules', { extra: [['VovaCorp', 'the operator']] }), 'the operator rules');
});

test('catalog drops the models Google removes on 2026-11-18 and carries their replacements', () => {
  const ids = new Set(MODEL_CATALOG.map((m) => m.id));
  for (const gone of ['claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium']) {
    assert.equal(ids.has(gone), false, gone);
  }
  for (const present of ['claude-sonnet-5-5-high', 'claude-opus-5-5-high', 'gemini-4-argon-high', 'gemini-3.1-flash-image']) {
    assert.equal(ids.has(present), true, present);
  }
  assert.equal(findModel('gemini-4-argon').id, 'gemini-4-argon-high');
  assert.equal(findModel('claude-opus-5-5').id, 'claude-opus-5-5-high');
  assert.equal(findModel('gemini-3.8-flash').id, 'gemini-3.8-flash-medium');
});

test('403 TOS_VIOLATION is classified as an account stop, not a permission blip', () => {
  const body = JSON.stringify({
    error: {
      status: 'PERMISSION_DENIED',
      details: [{
        reason: 'TOS_VIOLATION',
        metadata: { appeal_url: 'https://forms.gle/example' },
      }],
    },
  });
  const failure = describeFailure(upstreamErrorFrom(403, body, 'a', null, { model: 'gemini-3.8-flash-high' }));
  assert.equal(failure.reason, 'account_restricted');
  assert.equal(failure.scope, 'account');
  assert.equal(failure.evidence, 'error_status_tos_violation');
  assert.equal(failure.publicStatus, 502);
  const decision = decideFailure(failure, {});
  assert.equal(decision.sharedEffect, 'restrict_account');
  assert.equal(decision.sharedScope, 'account');
  assert.equal(decision.until, null);
  assert.equal(decision.outcome, 'tos_blocked');
});

test('a plain 403 without a TOS enum stays a request-local permission failure', () => {
  const failure = describeFailure(upstreamErrorFrom(403, JSON.stringify({ error: { status: 'PERMISSION_DENIED' } }), 'a'));
  assert.equal(failure.reason, 'permission_denied');
  assert.equal(failure.scope, 'request');
  assert.equal(decideFailure(failure, {}).sharedEffect, 'none');
});

test('structured quota evidence parks the account+model until the upstream reset time', () => {
  const now = Date.parse('2026-11-16T02:00:00Z');
  const reset = '2026-11-16T03:00:00Z';
  const body = JSON.stringify({
    error: {
      status: 'RESOURCE_EXHAUSTED',
      details: [{
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        reason: 'QUOTA_EXHAUSTED',
        metadata: { quotaResetTime: reset },
      }],
    },
  });
  const failure = describeFailure(upstreamErrorFrom(429, body, 'a', null, {
    model: 'gemini-3.8-flash-high', quotaCooldownMs: 0,
  }));
  assert.equal(failure.reason, 'scoped_quota');
  assert.equal(failure.scope, 'account_model');
  assert.equal(failure.model, 'gemini-3.8-flash-high');
  assert.equal(failure.retryAt, Date.parse(reset));
  assert.equal(failure.evidence, 'quota_reset_hint');
  const decision = decideFailure(failure, {});
  assert.equal(decision.sharedEffect, 'restrict');
  assert.equal(decision.sharedScope, 'account_model');
  assert.equal(decision.until, Date.parse(reset));
  assert.ok(now < decision.until);
});

test('a quota enum without a reset hint uses the configured default window', () => {
  const body = JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', details: [{ reason: 'QUOTA_EXHAUSTED' }] } });
  const before = Date.now();
  const failure = describeFailure(upstreamErrorFrom(429, body, 'a', null, {
    model: 'gemini-3.8-flash-high', quotaCooldownMs: 5000,
  }));
  assert.equal(failure.reason, 'scoped_quota');
  assert.equal(failure.evidence, 'quota_failure_detail');
  assert.ok(failure.retryAt >= before + 5000 - 50 && failure.retryAt <= Date.now() + 5000 + 50);
});

test('a transient per-request 429 stays request-local', () => {
  const body = JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', details: [{ reason: 'RATE_LIMIT_EXCEEDED' }] } });
  const failure = describeFailure(upstreamErrorFrom(429, body, 'a', null, { model: 'gemini-3.8-flash-high' }));
  assert.equal(failure.reason, 'rate_limit_unknown_scope');
  assert.equal(failure.scope, 'request');
  assert.equal(decideFailure(failure, {}).sharedEffect, 'none');
});

test('scoped restrictions and TOS blocks survive a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-pool-'));
  const statePath = path.join(dir, 'pool-state.json');
  const account = { id: 'acc-1', email: 'a@example.test', generation: 'g1' };
  const now = 1_000_000;
  try {
    const pool = new AccountPool({ now: () => now, statePath });
    pool.restrict({
      account, scope: 'account_model', model: 'gemini-3.8-flash-high',
      until: now + 60_000, reason: 'scoped_quota', evidence: 'quota_reset_hint',
    });
    pool.restrict({
      account, scope: 'account', until: null, reason: 'account_restricted',
      evidence: 'error_status_tos_violation',
    });
    assert.equal(fs.existsSync(statePath), true);
    const restored = new AccountPool({ now: () => now, statePath });
    const snapshot = restored.snapshot([account]);
    const scopes = snapshot.restrictions.map((r) => r.scope).sort();
    assert.deepEqual(scopes, ['account', 'account_model']);
    assert.equal(snapshot.credentialBlocks.length, 0);
    assert.equal(restored.healthy([account]).length, 0, 'a TOS block keeps the account out');
    // An expired quota park is dropped at load time.
    const later = new AccountPool({ now: () => now + 120_000, statePath });
    const laterSnapshot = later.snapshot([account]);
    assert.deepEqual(laterSnapshot.restrictions.map((r) => r.scope), ['account']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the pool state carries no email or token material', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-pool-'));
  const statePath = path.join(dir, 'pool-state.json');
  const account = { id: 'acc-2', email: 'secret@example.test', generation: 'g1' };
  try {
    const pool = new AccountPool({ now: () => 1_000_000, statePath });
    pool.blockGeneration({ account, generation: 'g1', reason: 'revoked_credential', evidence: 'oauth_invalid_grant' });
    const raw = fs.readFileSync(statePath, 'utf8');
    assert.equal(raw.includes('secret@example.test'), false);
    assert.equal(raw.includes('refresh_token'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
