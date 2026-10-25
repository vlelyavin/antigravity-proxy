// One structured, source-stamped failure contract for the AGY relay.
//
// Only trusted structured fields may classify a failure: the observed HTTP status, the exact
// `error.status` enum of a parsed JSON error object, an OAuth error code in the token endpoint's
// exact position, or a local observation made by this process (a parse failure, an egress stage,
// a deadline). Free-text messages are never inspected - not for `invalid_grant`, not for `quota`,
// not for anything else.
//
// `UpstreamError` keeps the historical `status`/`kind` fields for existing callers and journals,
// but `status` is the PUBLIC mapping and `observedStatus` is the true wire status. The policy reads
// `reason`, `scope`, `evidence`, `origin` and `phase`; it never reads a message.
import { errorCategory } from '../utils/error-category.js';
import { MODEL_CATALOG } from '../rewrite/models.js';

/** Fixed policy version carried by the journal and the `x-agy-policy` response header. */
export const POLICY_VERSION = 'agy-rotator-1';

export const ORIGINS = Object.freeze([
  'local', 'oauth', 'project', 'generation', 'egress', 'protocol', 'caller',
]);

export const PHASES = Object.freeze([
  'credential_load', 'refresh', 'project_resolution', 'connect', 'dispatch',
  'body_read', 'validation', 'stream', 'client',
]);

export const REASONS = Object.freeze([
  'client_cancelled',
  'deadline',
  'timeout',
  'invalid_request',
  'invalid_local_config',
  'budget_exhausted',
  'revoked_credential',
  'auth_rejected',
  'auth_rejected_after_refresh',
  'oauth_unavailable',
  'oauth_rejected',
  'oauth_malformed',
  'rate_limit_unknown_scope',
  'scoped_quota',
  'account_restricted',
  'project_restricted',
  'provider_unavailable',
  'endpoint_unavailable',
  'permission_denied',
  'model_unavailable',
  'egress_invalid_config',
  'egress_unavailable',
  'egress_refused',
  'truncated',
  'malformed',
  'empty_response',
  'unsuccessful_terminal',
  'resource_gated',
  'probe_lost',
  'credential_blocked',
  'credential_replaced',
  'refusal',
  'unknown',
]);

export const SCOPES = Object.freeze([
  'request', 'credential', 'account', 'account_model', 'project', 'provider', 'egress', 'unknown',
]);

// Allowlisted structured evidence codes. `error_<category>` is produced only from the fixed
// vocabulary in utils/error-category.js, so it cannot smuggle provider text into a journal.
export const EVIDENCE = Object.freeze([
  'http_400', 'http_401', 'http_403', 'http_404', 'http_429', 'http_4xx', 'http_5xx',
  'error_status_invalid_argument', 'error_status_unauthenticated', 'error_status_permission_denied',
  'error_status_resource_exhausted', 'error_status_unavailable', 'error_status_internal',
  'embedded_error', 'embedded_error_status_resource_exhausted',
  'retry_after_header',
  'oauth_invalid_grant', 'oauth_http_status', 'oauth_network', 'oauth_malformed_response',
  'sse_json_parse', 'json_body_parse', 'json_body_shape', 'stream_no_frames',
  'missing_terminal', 'unsuccessful_terminal',
  'attempt_ladder', 'first_frame_timeout', 'idle_timeout', 'request_deadline', 'local_abort',
  'egress_config', 'egress_dial', 'egress_handshake', 'egress_connect', 'egress_timeout',
  'dispatch_budget', 'pool_gate', 'resolved_gate', 'probe_ownership', 'credential_generation',
  'project_response', 'local_invalid_request', 'unclassified_error',
]);

const ORIGIN_SET = new Set(ORIGINS);
// Locally classified plain errors keep their identity while carrying the structured failure.
const FAILURE_BY_ERROR = new WeakMap();

export function annotateFailure(error, failure) {
  if (error && (typeof error === 'object' || typeof error === 'function')) FAILURE_BY_ERROR.set(error, failure);
  return error;
}

export function annotatedFailure(error) {
  return error && (typeof error === 'object' || typeof error === 'function')
    ? FAILURE_BY_ERROR.get(error) ?? null
    : null;
}
const PHASE_SET = new Set(PHASES);
const REASON_SET = new Set(REASONS);
const SCOPE_SET = new Set(SCOPES);
const EVIDENCE_SET = new Set(EVIDENCE);

function oneOf(value, set, fallback) {
  return typeof value === 'string' && set.has(value) ? value : fallback;
}

/** Legacy coarse `kind`, derived from the structured reason. Kept for journal compatibility. */
export function legacyKind(reason) {
  switch (reason) {
    case 'rate_limit_unknown_scope':
    case 'scoped_quota':
    case 'account_restricted':
    case 'project_restricted':
    case 'provider_unavailable':
      return 'quota';
    case 'revoked_credential':
    case 'auth_rejected':
    case 'auth_rejected_after_refresh':
    case 'permission_denied':
      return 'auth';
    case 'truncated':
      return 'truncated';
    case 'malformed':
    case 'empty_response':
      return 'malformed';
    case 'unsuccessful_terminal':
      return 'terminal';
    case 'timeout':
      return 'timeout';
    case 'deadline':
      return 'deadline';
    case 'client_cancelled':
      return 'client_abort';
    case 'egress_invalid_config':
    case 'egress_unavailable':
    case 'egress_refused':
      return 'egress';
    case 'invalid_request':
      return 'invalid_request';
    case 'budget_exhausted':
      return 'budget';
    default:
      return 'other';
  }
}

/**
 * Catalogue-validated model identifier for the journal. Arbitrary caller text is recorded as
 * `unknown` by the caller, never copied into a log field.
 */
export function journalModel(value) {
  if (typeof value !== 'string') return null;
  // Strip the vendor prefixes the translate layer accepts, without trusting arbitrary text.
  const bare = value.startsWith('models/') ? value.slice('models/'.length)
    : value.includes('/') ? value.slice(value.lastIndexOf('/') + 1)
      : value;
  const hit = MODEL_CATALOG.find((entry) => entry.id === bare || entry.upstreamModel === bare);
  return hit ? hit.id : null;
}

/** Retry-After (delta seconds or HTTP date) -> epoch ms; no cap and no inference. */
export function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return seconds > 0 ? now + seconds * 1000 : null;
  }
  const at = Date.parse(trimmed);
  return Number.isFinite(at) && at > now ? at : null;
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    try { return headers.get(name); } catch { return null; }
  }
  const lower = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === lower) return Array.isArray(value) ? value[0] : String(value);
  }
  return null;
}

/** The exact `error.status` enum of a parsed JSON error body, or null. Never scans message text. */
export function structuredErrorStatus(text) {
  if (typeof text !== 'string' || text === '') return null;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  const status = parsed?.error?.status;
  return typeof status === 'string' ? status : null;
}

function httpReason(httpStatus, structuredStatus) {
  if (structuredStatus === 'RESOURCE_EXHAUSTED' || httpStatus === 429) {
    return { reason: 'rate_limit_unknown_scope', evidence: httpStatus === 429 ? 'http_429' : 'error_status_resource_exhausted' };
  }
  if (structuredStatus === 'UNAUTHENTICATED' || httpStatus === 401) {
    return { reason: 'auth_rejected', evidence: httpStatus === 401 ? 'http_401' : 'error_status_unauthenticated' };
  }
  if (structuredStatus === 'PERMISSION_DENIED' || httpStatus === 403) {
    return { reason: 'permission_denied', evidence: httpStatus === 403 ? 'http_403' : 'error_status_permission_denied' };
  }
  if (structuredStatus === 'INVALID_ARGUMENT' || httpStatus === 400) {
    return { reason: 'invalid_request', evidence: httpStatus === 400 ? 'http_400' : 'error_status_invalid_argument' };
  }
  if (structuredStatus === 'NOT_FOUND' || httpStatus === 404) {
    return { reason: 'model_unavailable', evidence: httpStatus === 404 ? 'http_404' : 'error_status_invalid_argument' };
  }
  if (structuredStatus === 'UNAVAILABLE' || structuredStatus === 'INTERNAL' || httpStatus >= 500) {
    return { reason: 'endpoint_unavailable', evidence: httpStatus >= 500 ? 'http_5xx' : 'error_status_unavailable' };
  }
  if (httpStatus >= 400 && httpStatus < 500) {
    return { reason: 'unknown', evidence: 'http_4xx' };
  }
  return { reason: 'unknown', evidence: 'unclassified_error' };
}

function publicStatusFor(reason, observedStatus) {
  switch (reason) {
    case 'rate_limit_unknown_scope':
    case 'scoped_quota':
    case 'account_restricted':
    case 'project_restricted':
    case 'provider_unavailable':
      return 429;
    case 'invalid_request':
      return 400;
    case 'model_unavailable':
      return 404;
    case 'auth_rejected':
    case 'revoked_credential':
    case 'auth_rejected_after_refresh':
    case 'permission_denied':
      // Never turn an upstream credential/permission failure into the caller's API-key 401.
      return 502;
    case 'budget_exhausted':
      return 503;
    default:
      return Number.isInteger(observedStatus) && observedStatus >= 500 ? 502 : 502;
  }
}

/** Caller-safe text for a reason. Fixed strings only: no provider payload, no status text. */
export function publicFailureText(reason) {
  switch (reason) {
    case 'rate_limit_unknown_scope':
    case 'scoped_quota':
    case 'account_restricted':
    case 'project_restricted':
    case 'provider_unavailable':
      return 'upstream rate limited the request';
    case 'auth_rejected':
    case 'revoked_credential':
      return 'upstream rejected the credential';
    case 'auth_rejected_after_refresh':
      return 'upstream rejected the refreshed credential';
    case 'permission_denied':
      return 'upstream denied permission';
    case 'invalid_request':
      return 'upstream rejected the request';
    case 'model_unavailable':
      return 'upstream model is unavailable';
    case 'truncated':
      return 'upstream response ended before a terminal outcome';
    case 'malformed':
      return 'upstream response was malformed';
    case 'empty_response':
      return 'upstream returned no usable response';
    case 'unsuccessful_terminal':
      return 'upstream finished without a successful terminal outcome';
    case 'egress_invalid_config':
      return 'configured egress is invalid';
    case 'egress_unavailable':
    case 'egress_refused':
      return 'egress is unavailable';
    case 'timeout':
      return 'upstream request timed out';
    case 'deadline':
      return 'request deadline exceeded';
    case 'budget_exhausted':
      return 'upstream dispatch budget exhausted';
    default:
      return 'upstream request failed';
  }
}

/**
 * The one failure object the classifier and the policy share. Internal identity fields
 * (`accountId`, `generation`, `egressKey`, `projectId`) never reach a journal or a response.
 */
export class UpstreamError extends Error {
  constructor(message, options = {}) {
    super(typeof message === 'string' && message !== '' ? message : 'upstream request failed', options.cause ? { cause: options.cause } : undefined);
    this.name = 'UpstreamError';
    this.origin = oneOf(options.origin, ORIGIN_SET, 'generation');
    this.phase = oneOf(options.phase, PHASE_SET, 'dispatch');
    this.reason = oneOf(options.reason, REASON_SET, 'unknown');
    this.scope = oneOf(options.scope, SCOPE_SET, 'unknown');
    this.evidence = oneOf(options.evidence, EVIDENCE_SET, 'unclassified_error');
    this.observedStatus = Number.isInteger(options.observedStatus) ? options.observedStatus : null;
    const publicStatus = Number.isInteger(options.publicStatus)
      ? options.publicStatus
      : (Number.isInteger(options.status) ? options.status : publicStatusFor(this.reason, this.observedStatus));
    // `status` stays the PUBLIC mapping: no caller sees an upstream credential status as its own.
    this.publicStatus = publicStatus === 401 ? 502 : publicStatus;
    this.status = this.publicStatus;
    this.retryable = options.retryable === true;
    this.retryAt = Number.isFinite(options.retryAt) ? options.retryAt : null;
    this.retryAtSource = options.retryAtSource === 'retry_after' ? 'retry_after' : null;
    this.accountId = options.accountId ?? null;
    this.generation = options.generation ?? null;
    this.egressKey = options.egressKey ?? null;
    this.egressAlias = options.egressAlias ?? null;
    this.model = journalModel(options.model);
    this.projectId = options.projectId ?? null;
    this.kind = oneOf(options.kind, new Set(['auth', 'quota', 'timeout', 'truncated', 'terminal', 'malformed', 'egress', 'deadline', 'client_abort', 'budget', 'invalid_request', 'other']), legacyKind(this.reason));
    this.reported = options.reported === true;
  }
}

/**
 * Normalizes any thrown value into the structured failure the policy consumes. Meaning is taken
 * from trusted fields only; a message is never inspected. The original error keeps its identity
 * for the caller - this object is the classification, not a replacement error.
 */
export function describeFailure(error) {
  const annotated = annotatedFailure(error);
  if (annotated) return annotated;
  if (error instanceof UpstreamError) {
    return {
      kind: error.kind,
      origin: error.origin,
      phase: error.phase,
      reason: error.reason,
      scope: error.scope,
      evidence: error.evidence,
      observedStatus: error.observedStatus,
      publicStatus: error.publicStatus,
      retryable: error.retryable,
      retryAt: error.retryAt,
      retryAtSource: error.retryAtSource,
      accountId: error.accountId,
      generation: error.generation,
      egressKey: error.egressKey,
      egressAlias: error.egressAlias,
      model: error.model,
      projectId: error.projectId,
      reported: error.reported === true,
    };
  }
  if (error?.name === 'EgressError') {
    const reason = oneOf(error.reason, REASON_SET, 'egress_unavailable');
    const evidence = oneOf(error.evidence, EVIDENCE_SET, 'egress_dial');
    return {
      kind: 'egress', origin: 'egress', phase: 'connect', reason, scope: 'egress', evidence,
      observedStatus: null, publicStatus: 502, retryable: true,
      retryAt: null, retryAtSource: null, accountId: null, generation: null,
      egressKey: error.egressKey ?? null, egressAlias: error.egressAlias ?? null,
      model: null, projectId: null, reported: false,
    };
  }
  const code = typeof error?.code === 'string' ? error.code : null;
  if (code === 'request_deadline') {
    return {
      kind: 'deadline', origin: 'caller', phase: 'client', reason: 'deadline', scope: 'request',
      evidence: 'request_deadline', observedStatus: null, publicStatus: 504, retryable: false,
      retryAt: null, retryAtSource: null, accountId: null, generation: null, egressKey: null,
      egressAlias: null, model: null, projectId: null, reported: false,
    };
  }
  if (code === 'attempt_timeout' || code === 'first_frame_timeout' || code === 'idle_timeout') {
    return {
      kind: 'timeout', origin: 'generation', phase: 'stream', reason: 'timeout', scope: 'request',
      evidence: code, observedStatus: null, publicStatus: 504, retryable: true,
      retryAt: null, retryAtSource: null, accountId: null, generation: null, egressKey: null,
      egressAlias: null, model: null, projectId: null, reported: false,
    };
  }
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return {
      kind: 'timeout', origin: 'generation', phase: 'body_read', reason: 'timeout', scope: 'request',
      evidence: 'local_abort', observedStatus: null, publicStatus: 504, retryable: true,
      retryAt: null, retryAtSource: null, accountId: null, generation: null, egressKey: null,
      egressAlias: null, model: null, projectId: null, reported: false,
    };
  }
  if (error instanceof SyntaxError) {
    return {
      kind: 'malformed', origin: 'protocol', phase: 'validation', reason: 'malformed', scope: 'request',
      evidence: 'json_body_parse', observedStatus: null, publicStatus: 502, retryable: true,
      retryAt: null, retryAtSource: null, accountId: null, generation: null, egressKey: null,
      egressAlias: null, model: null, projectId: null, reported: false,
    };
  }
  if (error?.status === 400) {
    // Local request-shape rejection (schema/image URL/translation). It is caller input, not a
    // provider failure and not shared health evidence.
    return {
      kind: 'invalid_request', origin: 'local', phase: 'validation', reason: 'invalid_request',
      scope: 'request', evidence: 'local_invalid_request', observedStatus: null, publicStatus: 400,
      retryable: false, retryAt: null, retryAtSource: null, accountId: null, generation: null,
      egressKey: null, egressAlias: null, model: null, projectId: null, reported: false,
    };
  }
  const category = errorCategory(error);
  return {
    kind: 'other', origin: 'generation', phase: 'body_read', reason: 'unknown', scope: 'unknown',
    evidence: category === 'error' ? 'unclassified_error' : `error_${category}`,
    observedStatus: null, publicStatus: 502, retryable: true,
    retryAt: null, retryAtSource: null, accountId: null, generation: null, egressKey: null,
    egressAlias: null, model: null, projectId: null, reported: false,
  };
}

function classifyHttp(status, text, accountId, headers, { embedded = false, structuredStatus = null, generation = null, observedStatus = status } = {}) {
  const structured = structuredStatus ?? structuredErrorStatus(text);
  const picked = httpReason(status, structured);
  let evidence = picked.evidence;
  if (embedded) evidence = structured === 'RESOURCE_EXHAUSTED' ? 'embedded_error_status_resource_exhausted' : 'embedded_error';
  const retryAt = (picked.reason === 'rate_limit_unknown_scope' || picked.reason === 'endpoint_unavailable')
    ? parseRetryAfter(headerValue(headers, 'retry-after'))
    : null;
  const publicStatus = publicStatusFor(picked.reason, status);
  return new UpstreamError(publicFailureText(picked.reason), {
    origin: 'generation',
    phase: embedded ? 'validation' : 'dispatch',
    reason: picked.reason,
    scope: 'request',
    evidence,
    observedStatus: Number.isInteger(observedStatus) ? observedStatus : null,
    publicStatus,
    retryable: picked.reason === 'rate_limit_unknown_scope' || picked.reason === 'endpoint_unavailable' || picked.reason === 'unknown',
    retryAt,
    retryAtSource: retryAt === null ? null : 'retry_after',
    accountId,
    generation,
  });
}

/**
 * HTTP response status + body -> structured failure. Only `error.status` is read from the body;
 * an `invalid_grant` substring in an unrelated 400 message changes nothing.
 */
export function upstreamErrorFrom(status, text, accountId = null, headers = null, { generation = null } = {}) {
  return classifyHttp(status, text, accountId, headers, { generation });
}

/** An explicit SSE/JSON error object (bare or wrapped by the caller) -> structured failure. */
export function upstreamErrorFromJson(error, accountId = null, { generation = null, observedStatus = null } = {}) {
  const code = Number.isInteger(error?.code) ? error.code : null;
  const statusName = typeof error?.status === 'string' ? error.status : null;
  const pseudo = code ?? (statusName === 'RESOURCE_EXHAUSTED' ? 429
    : statusName === 'UNAUTHENTICATED' ? 401
      : statusName === 'PERMISSION_DENIED' ? 403
        : statusName === 'INVALID_ARGUMENT' ? 400
          : statusName === 'NOT_FOUND' ? 404
            : 502);
  return classifyHttp(pseudo, null, accountId, null, { embedded: true, structuredStatus: statusName, generation, observedStatus });
}

/** The caller-facing message: a fixed reason text plus the correlation reference. */
export function safeClientMessage(error, requestId) {
  const failure = describeFailure(error);
  const text = publicFailureText(failure.reason);
  return requestId ? `${text} (ref ${requestId})` : text;
}

/** Safe, bounded journal fields for one observed failure. */
export function failureFields(failure) {
  return {
    // Prefixed so a structured reason never overwrites the legacy `reason=kind:status` timing field.
    failureReason: failure.reason,
    failureOrigin: failure.origin,
    failurePhase: failure.phase,
    failureScope: failure.scope,
    failureEvidence: failure.evidence,
    observedStatus: failure.observedStatus,
    publicStatus: failure.publicStatus,
    policyVersion: POLICY_VERSION,
  };
}
