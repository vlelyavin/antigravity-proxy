// Source-stamped failure contract and pure rotation policy. Every input here is synthetic; no
// network and no real credential is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UpstreamError,
  upstreamErrorFrom,
  upstreamErrorFromJson,
} from '../src/upstream/upstream-client.js';
import { describeFailure, journalModel, parseRetryAfter, safeFinishReason } from '../src/upstream/failure.js';
import {
  SHARED_FAILURE_BUDGET,
  decideFailure,
  isProvenScopedQuota,
} from '../src/upstream/rotation-policy.js';
import { oauthErrorCode, refreshAccessToken } from '../src/credentials/oauth.js';

test('the observed wire status stays distinct from the public mapping', () => {
  const upstream500 = upstreamErrorFrom(500, JSON.stringify({ error: { status: 'INTERNAL' } }), 'a');
  assert.equal(upstream500.observedStatus, 500);
  assert.equal(upstream500.publicStatus, 502);
  assert.equal(upstream500.status, 502);
  assert.equal(upstream500.reason, 'endpoint_unavailable');
  assert.equal(upstream500.scope, 'request');

  const unauthorized = upstreamErrorFrom(401, '', 'a');
  assert.equal(unauthorized.observedStatus, 401);
  assert.equal(unauthorized.publicStatus, 502, 'an upstream credential 401 is never the caller API-key 401');
  assert.equal(unauthorized.reason, 'auth_rejected');

  const limited = upstreamErrorFrom(429, '', 'a');
  assert.equal(limited.observedStatus, 429);
  assert.equal(limited.publicStatus, 429);
  assert.equal(limited.reason, 'rate_limit_unknown_scope');
  assert.equal(limited.scope, 'request', 'a bare 429 has no proven quota owner');
});

test('arbitrary 400 text never becomes authentication or revocation evidence', () => {
  const body = JSON.stringify({
    error: { code: 400, message: 'invalid_grant in an unrelated sentence', status: 'INVALID_ARGUMENT' },
  });
  const failure = upstreamErrorFrom(400, body, 'a');
  assert.equal(failure.reason, 'invalid_request');
  assert.equal(failure.publicStatus, 400);
  assert.equal(failure.kind, 'invalid_request');
  assert.notEqual(failure.reason, 'auth_rejected');
});

test('a fixture with convenient quota fields does not activate a wider scope', () => {
  const error = {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    message: 'quota exceeded',
    details: [{
      reason: 'RATE_LIMIT_EXCEEDED',
      metadata: { model: 'gemini-3.8-flash-high', project: 'project-from-fixture', account: 'a@example.test' },
    }],
  };
  const failure = upstreamErrorFromJson(error, 'a');
  assert.equal(failure.reason, 'rate_limit_unknown_scope');
  assert.equal(failure.scope, 'request');
  assert.equal(failure.model, null);
  assert.equal(failure.projectId, null);
  assert.equal(isProvenScopedQuota(failure), false);
  const decision = decideFailure(failure, {});
  assert.equal(decision.sharedEffect, 'none');
  assert.equal(decision.sharedScope, null);
  assert.equal(decision.budget, 'shared');
});

test('Retry-After is parsed only from a real header and is never capped', () => {
  const now = 1_000_000;
  assert.equal(parseRetryAfter('120', now), now + 120_000);
  assert.equal(parseRetryAfter('86400', now), now + 86_400_000, 'a real server window is not shortened');
  assert.equal(parseRetryAfter(new Date(now + 60_000).toUTCString(), now), now + 60_000);
  assert.equal(parseRetryAfter('0', now), null);
  assert.equal(parseRetryAfter('soon', now), null);
  assert.equal(parseRetryAfter('', now), null);

  const headers = { 'retry-after': '90' };
  const limited = upstreamErrorFrom(429, '', 'a', headers);
  assert.ok(limited.retryAt >= Date.now() + 89_000);
  assert.equal(limited.retryAtSource, 'retry_after');
  const withoutHeader = upstreamErrorFrom(429, '', 'a');
  assert.equal(withoutHeader.retryAt, null);
});

test('OAuth invalid_grant is accepted only from the exact structured field', async () => {
  assert.equal(oauthErrorCode({ error: 'invalid_grant' }), 'invalid_grant');
  assert.equal(oauthErrorCode({ error: { code: 'invalid_grant' } }), null);
  assert.equal(oauthErrorCode({ error_description: 'invalid_grant' }), null);

  const failureFor = async (fetchImpl) => {
    try {
      await refreshAccessToken('refresh-token', { fetchImpl });
      throw new Error('expected a rejection');
    } catch (error) {
      return error;
    }
  };
  const revoked = await failureFor(async () => ({
    ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }),
  }));
  assert.equal(revoked.invalidGrant, true);
  assert.equal(revoked.reason, 'revoked_credential');
  assert.equal(revoked.evidence, 'oauth_invalid_grant');
  assert.equal(revoked.observedStatus, 400);

  const textOnly = await failureFor(async () => ({
    ok: false, status: 400, json: async () => ({ error: 'invalid_request', error_description: 'invalid_grant happened' }),
  }));
  assert.equal(textOnly.invalidGrant, false, 'a description mentioning invalid_grant proves nothing');
  assert.equal(textOnly.reason, 'oauth_rejected');

  const network = await failureFor(async () => { throw new Error('synthetic network failure'); });
  assert.equal(network.transient, true);
  assert.equal(network.invalidGrant, false);
  assert.equal(network.reason, 'oauth_unavailable');
  assert.equal(network.evidence, 'oauth_network');

  for (const status of [429, 500, 503]) {
    const transient = await failureFor(async () => ({ ok: false, status, json: async () => ({ error: 'backend_error' }) }));
    assert.equal(transient.transient, true, String(status));
    assert.equal(transient.invalidGrant, false, String(status));
    assert.equal(transient.reason, 'oauth_unavailable');
  }
  const malformed = await failureFor(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }));
  assert.equal(malformed.reason, 'oauth_malformed');
  assert.equal(malformed.invalidGrant, false);
});

test('policy: request-local alternates never write shared state', () => {
  const cases = [
    upstreamErrorFrom(429, '', 'a'),
    upstreamErrorFrom(502, '', 'a'),
    new UpstreamError('timeout', { reason: 'timeout', scope: 'request', phase: 'dispatch', evidence: 'attempt_ladder', publicStatus: 504 }),
    new UpstreamError('truncated', { reason: 'truncated', scope: 'request', phase: 'stream', evidence: 'missing_terminal', publicStatus: 502, kind: 'truncated' }),
    new UpstreamError('oauth transient', { reason: 'oauth_unavailable', scope: 'unknown', origin: 'oauth', phase: 'refresh', evidence: 'oauth_network', publicStatus: 502 }),
    new UpstreamError('permission', { reason: 'permission_denied', scope: 'unknown', phase: 'dispatch', evidence: 'http_403', publicStatus: 502 }),
  ];
  for (const failure of cases) {
    const decision = decideFailure(failure, {});
    assert.equal(decision.action, 'alternate', failure.reason);
    assert.equal(decision.sharedEffect, 'none', failure.reason);
    assert.equal(decision.budget, 'shared', `${failure.reason} spends the one shared failed-account budget`);
  }
  assert.equal(SHARED_FAILURE_BUDGET, 2);
});

test('policy: exact revocation blocks a generation; a second 401 only avoids it locally', () => {
  const revoked = new UpstreamError('revoked', {
    origin: 'oauth', phase: 'refresh', reason: 'revoked_credential', scope: 'credential',
    evidence: 'oauth_invalid_grant', publicStatus: 502,
  });
  const blocked = decideFailure(revoked, {});
  assert.equal(blocked.action, 'alternate');
  assert.equal(blocked.sharedEffect, 'block_credential');
  assert.equal(blocked.sharedScope, 'credential');
  assert.equal(blocked.budget, 'none');

  const first401 = upstreamErrorFrom(401, '', 'a');
  assert.equal(decideFailure(first401, { authRetryUsed: false }).action, 'retry_credential');
  const second = decideFailure(first401, { authRetryUsed: true });
  assert.equal(second.action, 'alternate');
  assert.equal(second.reason, 'auth_rejected_after_refresh');
  assert.equal(second.sharedEffect, 'none', 'a repeated 401 is not a revoked credential');
  assert.equal(second.budget, 'none');
});

test('policy: client cancellation and the request deadline outrank every penalty', () => {
  const cancelled = new UpstreamError('client gone', { reason: 'client_cancelled', scope: 'request', phase: 'client', evidence: 'local_abort', publicStatus: 499, kind: 'client_abort' });
  const deadline = new UpstreamError('deadline', { reason: 'deadline', scope: 'request', phase: 'client', evidence: 'request_deadline', publicStatus: 504, kind: 'deadline' });
  for (const failure of [cancelled, deadline]) {
    const decision = decideFailure(failure, {});
    assert.equal(decision.action, 'stop');
    assert.equal(decision.sharedEffect, 'none');
    assert.equal(decision.budget, 'none');
  }
});

test('policy: a committed caller stream stops retries but keeps proven health evidence', () => {
  const revoked = new UpstreamError('revoked', {
    origin: 'oauth', phase: 'refresh', reason: 'revoked_credential', scope: 'credential',
    evidence: 'oauth_invalid_grant', publicStatus: 502,
  });
  const committed = decideFailure(revoked, { headersCommitted: true });
  assert.equal(committed.action, 'stop');
  assert.equal(committed.stopReason, 'headers_committed');
  assert.equal(committed.sharedEffect, 'block_credential', 'no retry is not no classification');

  const limited = decideFailure(upstreamErrorFrom(429, '', 'a'), { headersCommitted: true });
  assert.equal(limited.action, 'stop');
  assert.equal(limited.sharedEffect, 'none', 'a bare 429 never becomes shared evidence, committed or not');
});

test('policy: proven egress failures gate that egress, invalid config gates it permanently', () => {
  const unavailable = new UpstreamError('egress', {
    origin: 'egress', phase: 'connect', reason: 'egress_unavailable', scope: 'egress',
    evidence: 'egress_connect', publicStatus: 502,
  });
  const decision = decideFailure(unavailable, {});
  assert.equal(decision.sharedEffect, 'cool_egress');
  assert.equal(decision.sharedScope, 'egress');
  assert.equal(decision.budget, 'none', 'an egress failure is not a failed account');

  const invalid = new UpstreamError('egress config', {
    origin: 'egress', phase: 'connect', reason: 'egress_invalid_config', scope: 'egress',
    evidence: 'egress_config', publicStatus: 502,
  });
  assert.equal(decideFailure(invalid, {}).sharedEffect, 'cool_egress');
});

test('journal helpers keep model and finish-reason fields inside their allowlists', () => {
  assert.equal(journalModel('gemini-3.8-flash-high'), 'gemini-3.8-flash-high');
  assert.equal(journalModel('google/gemini-3.8-flash-high'), 'gemini-3.8-flash-high');
  assert.equal(journalModel('gemini-pro-agent'), 'gemini-3.1-pro-high');
  assert.equal(journalModel('SENTINEL_ARBITRARY_MODEL_TEXT'), null);
  assert.equal(safeFinishReason('MALFORMED_FUNCTION_CALL'), 'MALFORMED_FUNCTION_CALL');
  assert.equal(safeFinishReason('sneaky payload with spaces'), 'invalid');
  const failure = describeFailure(upstreamErrorFrom(502, 'SENTINEL_BODY', 'a'));
  assert.equal(JSON.stringify(failure).includes('SENTINEL_BODY'), false, 'the classifier never copies a body');
});
