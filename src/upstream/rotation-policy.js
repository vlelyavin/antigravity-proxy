// Pure rotation policy: one structured failure in, one decision out. No I/O, no clock, no pool.
//
// The policy never widens an observed scope. A bare 429 / RESOURCE_EXHAUSTED is a request-local
// rate limit with UNKNOWN owner: it may rotate to another account inside this request and it may
// not write shared account/model state. Broad account/model/project/provider quota remains
// contract vocabulary only: no genuine AGY quota metadata was established, so the scoped branch is
// inactive until a separately reviewed adapter exists; a fixture cannot activate it.
import { POLICY_VERSION } from './failure.js';

/** Unknown/protocol/transient failures share this one request-local failed-account budget. */
export const SHARED_FAILURE_BUDGET = 2;

/** Locally proven egress failure gates that egress only, for one short local window. */
export const EGRESS_COOLDOWN_MS = 30_000;

const SHARED_BUDGET_REASONS = new Set([
  'rate_limit_unknown_scope', 'endpoint_unavailable', 'unknown', 'timeout', 'permission_denied',
  'model_unavailable', 'truncated', 'malformed', 'empty_response', 'unsuccessful_terminal',
  'oauth_unavailable', 'oauth_rejected', 'oauth_malformed',
  'account_restricted', 'project_restricted', 'provider_unavailable',
]);

function decision(failure, fields) {
  return {
    policyVersion: POLICY_VERSION,
    reason: fields.reason ?? failure.reason,
    scope: fields.scope ?? failure.scope,
    evidence: failure.evidence,
    origin: failure.origin,
    phase: failure.phase,
    observedStatus: failure.observedStatus,
    publicStatus: fields.publicStatus ?? failure.publicStatus,
    retryAt: failure.retryAt ?? null,
    retryAtSource: failure.retryAt ? failure.retryAtSource : null,
    action: 'stop',
    budget: 'none',
    sharedEffect: 'none',
    sharedScope: null,
    outcome: 'error',
    retryable: failure.retryable === true,
    headerReason: 'transient',
    stopReason: null,
    ...fields,
  };
}

/**
 * @param failure structured failure from failure.js
 * @param context {headersCommitted, authRetryUsed, canRetryCredential, phase}
 */
export function decideFailure(failure, context = {}) {
  const headersCommitted = context.headersCommitted === true;
  const authRetryUsed = context.authRetryUsed === true;
  let out;

  switch (failure.reason) {
    case 'client_cancelled':
      out = decision(failure, { action: 'stop', outcome: 'client_abort', headerReason: 'client_cancelled' });
      break;
    case 'deadline':
      out = decision(failure, { action: 'stop', outcome: 'deadline', headerReason: 'deadline' });
      break;
    case 'invalid_request':
      out = decision(failure, { action: 'stop', outcome: 'invalid_request', headerReason: 'invalid_request' });
      break;
    case 'invalid_local_config':
      out = decision(failure, { action: 'stop', outcome: 'invalid_config', headerReason: 'invalid_config' });
      break;
    case 'budget_exhausted':
      out = decision(failure, { action: 'stop', outcome: 'budget', headerReason: 'budget' });
      break;
    case 'credential_blocked':
      out = decision(failure, { action: 'alternate', outcome: 'credential_blocked', headerReason: 'credential_blocked' });
      break;
    case 'credential_replaced':
      // The material changed while this attempt was preparing: no wire dispatch happened.
      out = decision(failure, { action: 'retry_replaced', outcome: 'credential_replaced', headerReason: 'transient' });
      break;
    case 'probe_lost':
      out = decision(failure, { action: 'alternate', outcome: 'probe_lost', headerReason: 'resource_gated' });
      break;
    case 'resource_gated':
      out = decision(failure, { action: 'alternate', outcome: 'resource_gated', headerReason: 'resource_gated' });
      break;
    case 'revoked_credential':
      // Only an exact structured token-endpoint invalid_grant reaches this branch.
      out = decision(failure, {
        action: 'alternate',
        budget: 'none',
        sharedEffect: 'block_credential',
        sharedScope: 'credential',
        outcome: 'auth_revoked',
        headerReason: 'auth',
      });
      break;
    case 'auth_rejected':
      if (context.phase === 'project_resolution') {
        // A project probe is one POST per credential; a refresh would need a second one.
        out = decision(failure, { action: 'alternate', outcome: 'auth', headerReason: 'auth' });
      } else if (!authRetryUsed && context.canRetryCredential !== false) {
        out = decision(failure, {
          action: 'retry_credential', outcome: 'auth_retry', headerReason: 'auth',
        });
      } else {
        out = decision(failure, {
          reason: authRetryUsed ? 'auth_rejected_after_refresh' : 'auth_rejected',
          action: 'alternate',
          outcome: 'auth',
          headerReason: 'auth',
          stopReason: authRetryUsed ? null : 'credential_dispatch_budget',
        });
      }
      break;
    case 'auth_rejected_after_refresh':
      out = decision(failure, { action: 'alternate', outcome: 'auth', headerReason: 'auth' });
      break;
    case 'rate_limit_unknown_scope':
      // Request-local alternate only: no shared account/model state, no guessed owner.
      out = decision(failure, { action: 'alternate', outcome: 'rate_limited', headerReason: 'quota' });
      break;
    case 'scoped_quota':
      // No AGY adapter recognizes scoped quota yet; vocabulary alone is not evidence.
      out = decision(failure, {
        reason: 'rate_limit_unknown_scope', scope: 'request', action: 'alternate',
        outcome: 'rate_limited', headerReason: 'quota',
      });
      break;
    case 'egress_invalid_config':
      out = decision(failure, {
        action: 'alternate',
        sharedEffect: 'cool_egress',
        sharedScope: 'egress',
        outcome: 'egress_config',
        headerReason: 'egress',
      });
      break;
    case 'egress_unavailable':
    case 'egress_refused':
      out = decision(failure, {
        action: 'alternate',
        sharedEffect: 'cool_egress',
        sharedScope: 'egress',
        outcome: 'egress',
        headerReason: 'egress',
      });
      break;
    case 'permission_denied':
      out = decision(failure, { action: 'alternate', outcome: 'permission', headerReason: 'permission' });
      break;
    case 'model_unavailable':
      out = decision(failure, { action: 'alternate', outcome: 'invalid_request', headerReason: 'invalid_request' });
      break;
    case 'truncated':
    case 'malformed':
    case 'empty_response':
    case 'unsuccessful_terminal':
      out = decision(failure, { action: 'alternate', outcome: 'protocol', headerReason: 'protocol' });
      break;
    case 'timeout':
      out = decision(failure, { action: 'alternate', outcome: 'timeout', headerReason: 'timeout' });
      break;
    case 'endpoint_unavailable':
      out = decision(failure, { action: 'alternate', outcome: 'transient', headerReason: 'transient' });
      break;
    case 'oauth_unavailable':
    case 'oauth_rejected':
    case 'oauth_malformed':
      out = decision(failure, { action: 'alternate', outcome: 'oauth', headerReason: 'transient' });
      break;
    case 'refusal':
      out = decision(failure, { action: 'stop', outcome: 'refusal', headerReason: 'invalid_request' });
      break;
    default:
      out = decision(failure, { action: 'alternate', outcome: 'transient', headerReason: 'transient' });
      break;
  }

  if (SHARED_BUDGET_REASONS.has(out.reason) && out.budget === 'none') out.budget = 'shared';

  if (headersCommitted && out.action !== 'stop') {
    // A committed caller stream is never replayed or mixed. Proven shared health evidence is
    // still applied by the handler; only the retry is suppressed.
    out.action = 'stop';
    out.stopReason = 'headers_committed';
  }
  return out;
}
