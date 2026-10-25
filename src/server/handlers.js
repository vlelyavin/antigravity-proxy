import { antigravityToOpenAi, antigravityChunkToOpenAiChunk } from '../rewrite/openai-translate.js';
import { abortFailure, UpstreamError, upstreamErrorFromJson, generationOf } from '../upstream/upstream-client.js';
import { generateViaVertexFallback, isGeminiFamily, openAiJsonToStreamFrames } from '../upstream/vertex-fallback.js';
import { accountLabel } from '../utils/alias.js';
import { errorCategory } from '../utils/error-category.js';
import {
  POLICY_VERSION,
  annotateFailure,
  annotatedFailure,
  describeFailure,
  failureFields,
  journalModel,
  publicFailureText,
  safeFinishReason,
} from '../upstream/failure.js';
import {
  EGRESS_COOLDOWN_MS,
  SHARED_FAILURE_BUDGET,
  decideFailure,
} from '../upstream/rotation-policy.js';
import { createDispatchBudget } from '../upstream/dispatch-budget.js';
import { createCallContext } from './call-context.js';

import { createHash, timingSafeEqual } from 'node:crypto';

export function checkApiKey(config, req) {
  // "none" (string) is a documented no-key value, same as unset
  if (!config.apiKey || config.apiKey === 'none') return true;
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const xKey = req.headers['x-api-key'] || null;
  const xGoog = req.headers['x-goog-api-key'] || null;
  // timing-safe compare: hash both sides to equal length first
  const provided = [bearer, xKey, xGoog].find((v) => typeof v === 'string' && v.length > 0);
  if (!provided) return false;
  const a = createHash('sha256').update(String(config.apiKey)).digest();
  const b = createHash('sha256').update(provided).digest();
  return timingSafeEqual(a, b);
}

export function errorResponse(res, status, message, type = 'invalid_request_error', headers = {}) {
  const body = JSON.stringify({ error: { message, type, code: status } });
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

// One request budget over preparation, every rotation attempt, the stream collection and the
// fallback. Mari cuts the turn at 120 s, so the default sits just under it: a caller that waits
// longer raises rotation.requestDeadlineMs, and nobody depends on a caller header reaching us
// through a gateway. The per-attempt ladder (x-attempt-timeouts-ms or rotation.attemptTimeoutsMs)
// only shortens a single attempt inside this budget; it can never extend the request.
const DEFAULT_REQUEST_DEADLINE_MS = 110_000;
const MAX_REQUEST_DEADLINE_MS = 600_000;
// Flow-aware attempt caps: the wait for the first meaningful frame, then the gap between meaningful
// frames. They bound a socket the upstream holds open without progress; they never buy an attempt
// more time on the absolute ladder or on the request budget.
const DEFAULT_FIRST_MEANINGFUL_FRAME_MS = 45_000;
const DEFAULT_IDLE_MS = 30_000;

export function resolveRequestDeadlineMs(config) {
  const configured = config?.rotation?.requestDeadlineMs;
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_REQUEST_DEADLINE_MS;
  return Math.min(configured, MAX_REQUEST_DEADLINE_MS);
}

/** rotation.firstMeaningfulFrameTimeoutMs / rotation.idleTimeoutMs, with a positive-value guard. */
export function resolveFlowTimeouts(config) {
  const rotation = config?.rotation ?? {};
  const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);
  return {
    firstMeaningfulFrameMs: positive(rotation.firstMeaningfulFrameTimeoutMs, DEFAULT_FIRST_MEANINGFUL_FRAME_MS),
    idleMs: positive(rotation.idleTimeoutMs, DEFAULT_IDLE_MS),
  };
}

/** The i-th attempt's own cap; without a ladder only the request deadline bounds an attempt. */
function attemptCapMs(attemptTimeoutsMs, attempt) {
  if (!Array.isArray(attemptTimeoutsMs) || attemptTimeoutsMs.length === 0) return Infinity;
  const value = attemptTimeoutsMs[Math.min(attempt, attemptTimeoutsMs.length - 1)];
  return Number.isFinite(value) && value > 0 ? value : Infinity;
}

/**
 * Payload-free failure category for the journal. The structured fields are emitted separately by
 * `failureFields`; this legacy string keeps the timing lines readable.
 */
export function failureReason(error) {
  if (!error) return null;
  if (error instanceof UpstreamError) return `${error.kind}:${error.publicStatus}`;
  const annotated = annotatedFailure(error);
  if (annotated) return `${annotated.kind}:${annotated.publicStatus}`;
  return errorCategory(error);
}

function safeEffort(value) {
  return ['low', 'medium', 'high', 'max', 'xhigh', 'ultra', 'minimal', 'none', 'off'].includes(value)
    ? value
    : null;
}

/** x-agy-reason vocabulary: fixed and safe. */
export function headerReasonFor(error) {
  if (!error) return null;
  switch (describeFailure(error).reason) {
    case 'rate_limit_unknown_scope':
    case 'scoped_quota':
    case 'account_restricted':
    case 'project_restricted':
    case 'provider_unavailable':
      return 'quota';
    case 'revoked_credential':
    case 'auth_rejected':
    case 'auth_rejected_after_refresh':
      return 'auth';
    case 'permission_denied':
      return 'permission';
    case 'truncated':
    case 'malformed':
    case 'empty_response':
    case 'unsuccessful_terminal':
      return 'protocol';
    case 'egress_invalid_config':
    case 'egress_unavailable':
    case 'egress_refused':
      return 'egress';
    case 'timeout':
      return 'timeout';
    case 'deadline':
      return 'deadline';
    case 'client_cancelled':
      return 'client_cancelled';
    case 'budget_exhausted':
      return 'budget';
    case 'invalid_request':
      return 'invalid_request';
    case 'invalid_local_config':
      return 'invalid_config';
    case 'resource_gated':
    case 'probe_lost':
      return 'resource_gated';
    case 'credential_blocked':
      return 'credential_blocked';
    default:
      return 'transient';
  }
}

function clientAbortError() {
  return new UpstreamError('client disconnected', {
    status: 499, origin: 'caller', phase: 'client', reason: 'client_cancelled', scope: 'request',
    evidence: 'local_abort', publicStatus: 499, kind: 'client_abort',
  });
}

function deadlineError(deadlineMs) {
  return new UpstreamError(`request deadline of ${deadlineMs}ms exceeded`, {
    status: 504, origin: 'caller', phase: 'client', reason: 'deadline', scope: 'request',
    evidence: 'request_deadline', publicStatus: 504, kind: 'deadline',
  });
}

function credentialReplacedError(account, generation) {
  return new UpstreamError('credential material changed before dispatch', {
    status: 502, origin: 'generation', phase: 'dispatch', reason: 'credential_replaced',
    scope: 'credential', evidence: 'credential_generation', publicStatus: 502,
    accountId: account.id, generation,
  });
}

function probeLostError(account, generation) {
  return new UpstreamError('recovery probe ownership lost before dispatch', {
    status: 503, origin: 'generation', phase: 'dispatch', reason: 'probe_lost',
    scope: 'request', evidence: 'probe_ownership', publicStatus: 503,
    accountId: account.id, generation,
  });
}

function resourceGatedError(account, gate, generation, projectId) {
  return new UpstreamError('resolved resource is restricted', {
    status: 503, origin: 'project', phase: 'project_resolution', reason: 'resource_gated',
    scope: gate.scope, evidence: 'resolved_gate', publicStatus: 503,
    accountId: account.id, generation, projectId,
  });
}

// ---------------------------------------------------------------------------------------------
// Terminal outcome of one generation.
//
// The translate layer maps a finish reason to the OpenAI one and defaults an unknown value to
// `stop`. At this boundary that default is not acceptable: a generation only ends successfully with
// a documented terminal outcome, and anything else (MALFORMED_FUNCTION_CALL, LANGUAGE, OTHER, the
// IMAGE_* reasons, an unspecified or an unknown value) becomes an explicit protocol failure instead
// of a fabricated success. The mapping itself stays in the translate module, untouched.
// ---------------------------------------------------------------------------------------------
const SUCCESSFUL_TERMINALS = new Set([
  'STOP', // completed: openai `stop`
  'MAX_TOKENS', // completed, cut by the output budget: openai `length`
  'SAFETY', // refusal: openai `content_filter`
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
]);

/** Is this upstream finish reason a documented end of a generation for the caller? */
export function isSuccessfulTerminal(finishReason) {
  return typeof finishReason === 'string' && SUCCESSFUL_TERMINALS.has(finishReason);
}

/** The raw upstream finishReason of an antigravity frame, or null when the frame carries none. */
function rawFinishReason(frame) {
  const wrapper = frame?.response ?? frame;
  const reason = wrapper?.candidates?.[0]?.finishReason;
  return reason ?? null;
}

function explicitUpstreamError(payload) {
  return payload?.error || payload?.response?.error || null;
}

function unsuccessfulTerminal(accountId, finishReason, generation) {
  return new UpstreamError(
    `upstream finished with an unsuccessful finish reason: ${safeFinishReason(finishReason)}`,
    {
      status: 502, origin: 'protocol', phase: 'stream', reason: 'unsuccessful_terminal',
      scope: 'request', evidence: 'unsuccessful_terminal', publicStatus: 502,
      accountId, generation, kind: 'terminal',
    },
  );
}

function malformedFrame(accountId, generation) {
  return new UpstreamError('upstream sent a malformed SSE frame', {
    status: 502, origin: 'protocol', phase: 'stream', reason: 'malformed', scope: 'request',
    evidence: 'sse_json_parse', publicStatus: 502, accountId, generation, kind: 'malformed',
  });
}

function truncatedCompletion(accountId, generation) {
  return new UpstreamError('upstream response ended without a finish reason (truncated)', {
    status: 502, origin: 'protocol', phase: 'stream', reason: 'truncated', scope: 'request',
    evidence: 'missing_terminal', publicStatus: 502, accountId, generation, kind: 'truncated',
  });
}

function emptyStream(accountId, generation) {
  return new UpstreamError('upstream stream produced no frames', {
    status: 502, origin: 'protocol', phase: 'stream', reason: 'empty_response', scope: 'request',
    evidence: 'stream_no_frames', publicStatus: 502, accountId, generation, kind: 'malformed',
  });
}

function malformedBody(accountId, generation, error) {
  return new UpstreamError('upstream response body was malformed', {
    status: 502, origin: 'protocol', phase: 'validation', reason: 'malformed', scope: 'request',
    evidence: 'json_body_parse', publicStatus: 502, accountId, generation, kind: 'malformed', cause: error,
  });
}

function malformedShape(accountId, generation) {
  return new UpstreamError('upstream response body had an unsupported shape', {
    status: 502, origin: 'protocol', phase: 'validation', reason: 'malformed', scope: 'request',
    evidence: 'json_body_shape', publicStatus: 502, accountId, generation, kind: 'malformed',
  });
}

/**
 * Real generation progress: text, thinking, a tool call, a refusal or an explicit terminal. Empty
 * candidates, keepalives and role-only deltas are none of those - they keep the socket warm and
 * nothing else.
 */
function hasSignatureProgress(frame) {
  const wrapper = frame?.response ?? frame;
  const parts = wrapper?.candidates?.[0]?.content?.parts;
  return Array.isArray(parts) && parts.some((part) => typeof part?.thoughtSignature === 'string' && part.thoughtSignature !== '');
}

export function isMeaningfulChunk(chunk) {
  const choice = chunk?.choices?.[0];
  if (!choice) return false;
  const delta = choice.delta ?? {};
  return (typeof delta.content === 'string' && delta.content !== '')
    || (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '')
    || (typeof delta.tool_calls === 'object' && delta.tool_calls !== null && delta.tool_calls.length > 0)
    || (typeof delta.refusal === 'string' && delta.refusal !== '')
    || Boolean(choice.finish_reason);
}

/**
 * The two flow-aware timers of one attempt. `progress()` is called on every meaningful chunk: it
 * clears the first-frame wait and re-arms the idle wait. Nothing here touches the request deadline
 * or the explicit ladder, so a flowing answer can never extend either. `dispose()` must run when the
 * attempt ends: it leaves no timer behind.
 */
export function createFlowWatchdog({ firstMeaningfulFrameMs, idleMs, onStall }) {
  let satisfied = false;
  let idleTimer = null;
  let firstTimer = null;
  const clearIdle = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  };
  if (Number.isFinite(firstMeaningfulFrameMs) && firstMeaningfulFrameMs > 0) {
    firstTimer = setTimeout(() => {
      firstTimer = null;
      if (!satisfied) onStall('first_frame_timeout', firstMeaningfulFrameMs);
    }, firstMeaningfulFrameMs);
  }
  return {
    get satisfied() { return satisfied; },
    progress() {
      satisfied = true;
      if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
      clearIdle();
      if (Number.isFinite(idleMs) && idleMs > 0) {
        idleTimer = setTimeout(() => {
          idleTimer = null;
          onStall('idle_timeout', idleMs);
        }, idleMs);
      }
    },
    dispose() {
      if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
      clearIdle();
    },
  };
}


function applySharedEffect(pool, decision, { account, generation, context, config, now }) {
  if (decision.sharedEffect === 'block_credential') {
    return pool.blockGeneration({
      account, generation, reason: decision.reason, evidence: decision.evidence,
    });
  }
  if (decision.sharedEffect === 'cool_egress') {
    if (!context?.egressKey) return { applied: false, effect: 'unknown_egress' };
    return pool.restrict({
      account,
      scope: 'egress',
      egressKey: context.egressKey,
      egressAlias: context.egressAlias,
      until: decision.reason === 'egress_invalid_config' ? null : now + EGRESS_COOLDOWN_MS,
      reason: decision.reason,
      evidence: decision.evidence,
      generation,
    });
  }
  if (decision.sharedEffect === 'cool_scoped') {
    const until = decision.retryAt ?? now + (config?.rotation?.cooldownMs ?? 60_000);
    return pool.restrict({
      account,
      scope: decision.sharedScope,
      model: decision.sharedScope === 'account_model' ? context?.model ?? null : null,
      projectId: decision.sharedScope === 'project' ? context?.projectId ?? null : null,
      provider: decision.sharedScope === 'provider' ? 'agy' : null,
      until,
      reason: decision.reason,
      evidence: decision.evidence,
      generation,
    });
  }
  return { applied: false, effect: 'none' };
}

/**
 * Runs an OpenAI-shaped request through the pool. Request-local avoidance (`tried`) is never mixed
 * with shared pool state: only a proven scoped decision mutates the pool, and a committed caller
 * stream is never replayed.
 */
export async function handleWithRotation({
  pool, store, upstream, config, logger, openAiBody, req, res, signal,
  respondNative = false, attemptTimeoutsMs = [], call = null,
}) {
  const ctx = call ?? createCallContext(req, { model: openAiBody.model });
  ctx.setModel(openAiBody.model);
  const requestId = ctx.requestId;
  const startedAt = Date.now();
  const deadlineMs = resolveRequestDeadlineMs(config);
  const flowTimeouts = resolveFlowTimeouts(config);
  const deadlineAt = startedAt + deadlineMs;
  const deadlineReached = new AbortController();
  const deadlineTimer = setTimeout(() => {
    deadlineReached.abort(Object.assign(new Error(`request deadline of ${deadlineMs}ms exceeded`), { code: 'request_deadline' }));
  }, deadlineMs);
  // The caller's signal and the total deadline both stop the upstream work; the flags below keep
  // them apart, because neither is an upstream failure.
  const clientGone = () => signal?.aborted === true;
  const outOfTime = () => deadlineReached.signal.aborted || Date.now() >= deadlineAt;
  const requestSignal = signal ? AbortSignal.any([signal, deadlineReached.signal]) : deadlineReached.signal;

  let accounts = [];
  let storeError = null;
  try {
    accounts = store.readAll();
  } catch (error) {
    // missing/corrupt credential files: the pool is empty — still fall back
    storeError = error;
  }
  const budget = createDispatchBudget({ credentials: Array.isArray(accounts) ? accounts.length : 0 });
  const tried = new Set();
  const authRetried = new Set();
  const replacedRetried = new Set();

  const freshGenerationFor = (accountId) => {
    try {
      const fresh = store.readAll();
      const hit = fresh.find((account) => account.id === accountId);
      return hit ? { known: true, generation: generationOf(hit) } : { known: true, generation: null };
    } catch {
      return { known: false, generation: null };
    }
  };

  const buildContext = (account, { projectId = null } = {}) => {
    const egress = typeof upstream.egressIdentityFor === 'function'
      ? upstream.egressIdentityFor(account)
      : { key: null, alias: 'direct' };
    return {
      generation: generationOf(account),
      model: journalModel(openAiBody.model) ?? null,
      egressKey: egress.key,
      egressAlias: egress.alias,
      projectId: projectId ?? account.projectId ?? null,
    };
  };

  let account = null;
  let selection = null;
  let attemptGeneration = null;
  let attemptContext = null;
  let retrySame = false;
  let sharedRemaining = SHARED_FAILURE_BUDGET;
  let lastError = null;
  let lastFailure = null;
  let lastDecision = null;
  let stopReason = null;
  let exhaustion = null;
  let attemptsMade = 0;
  const attemptFailures = [];
  let requestOutcome = 'failed';
  let status = 502;

  const maxIterations = Math.max(2, accounts.length * 2 + 2);

  try {
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (clientGone()) { requestOutcome = 'client_abort'; throw clientAbortError(); }
      if (outOfTime()) {
        lastError = deadlineError(deadlineMs);
        lastFailure = describeFailure(lastError);
        requestOutcome = 'deadline';
        stopReason = 'deadline';
        break;
      }
      if (!retrySame) {
        selection = pool.select(accounts, { tried, context: (candidate) => buildContext(candidate) });
        if (!selection.account) {
          exhaustion = selection;
          stopReason = 'pool_exhausted';
          break;
        }
        account = selection.account;
        attemptGeneration = selection.context?.generation ?? generationOf(account);
        attemptContext = selection.context;
        tried.add(account.id);
      }
      retrySame = false;
      attemptsMade += 1;
      budget.recordAttempt();
      const attempt = attemptsMade - 1;
      const attemptStartedAt = Date.now();
      // The ladder shortens one non-stream attempt (a client-facing stream has no ladder); what is
      // left of the request budget always caps it. Both caps are absolute: a keepalive frame keeps
      // the socket warm but is not progress, so it never buys the attempt more time.
      const ladderMs = openAiBody.stream ? Infinity : attemptCapMs(attemptTimeoutsMs, attempt);
      const attemptMs = Math.min(ladderMs, deadlineAt - attemptStartedAt);
      const attemptAbort = new AbortController();
      const forwardAbort = () => attemptAbort.abort(abortFailure(requestSignal));
      if (requestSignal.aborted) forwardAbort();
      else requestSignal.addEventListener('abort', forwardAbort, { once: true });
      const attemptTimer = Number.isFinite(ladderMs)
        ? setTimeout(() => attemptAbort.abort(Object.assign(new Error(`attempt timed out after ${attemptMs}ms`), { code: 'attempt_timeout' })), attemptMs)
        : null;
      const attemptSignal = attemptAbort.signal;
      const timing = { startedAt: attemptStartedAt, prepMs: null, firstFrameMs: null };
      const flow = respondNative === true ? null : createFlowWatchdog({
        firstMeaningfulFrameMs: flowTimeouts.firstMeaningfulFrameMs,
        idleMs: flowTimeouts.idleMs,
        onStall: (code, timeoutMs) => attemptAbort.abort(Object.assign(
          new Error(code === 'first_frame_timeout'
            ? `upstream sent no meaningful frame within ${timeoutMs}ms`
            : `upstream stalled for ${timeoutMs}ms after making progress`),
          { code },
        )),
      });
      let attemptOutcome = 'error';
      let decision = null;
      let retry = false;
      let abortCode = null;
      let stateEffect = null;
      let attemptFailure = null;
      let attemptDecision = null;

      logger.info('attempt.start', {
        requestId,
        attempt,
        account: accountLabel(account),
        stream: openAiBody.stream === true,
        native: respondNative === true,
        route: 'agy',
        modelRequested: ctx.modelRequested,
        egress: attemptContext?.egressAlias ?? 'direct',
        policyVersion: POLICY_VERSION,
      });

      const beforeDispatch = async (meta) => {
        if (clientGone()) throw clientAbortError();
        if (outOfTime()) throw deadlineError(deadlineMs);
        if (meta.outboundModel) ctx.setOutboundModel(meta.outboundModel);
        if (meta.generation !== attemptGeneration) {
          throw credentialReplacedError(account, attemptGeneration);
        }
        if (!pool.probeAlive(selection)) throw probeLostError(account, attemptGeneration);
        const fresh = freshGenerationFor(account.id);
        if (fresh.known && fresh.generation !== attemptGeneration) {
          throw credentialReplacedError(account, attemptGeneration);
        }
        attemptContext = buildContext(account, { projectId: meta.projectId });
        const gate = typeof pool.gateFor === 'function'
          ? pool.gateFor(account, attemptContext, selection)
          : null;
        if (gate) throw resourceGatedError(account, gate, attemptGeneration, meta.projectId);
      };

      try {
        const dispatchOptions = {
          upstream, logger, account, openAiBody, signal: attemptSignal, timing, flow,
          requestId, call: ctx, budget, beforeDispatch, generation: attemptGeneration,
        };
        if (respondNative === true) {
          await handleNonStream({ ...dispatchOptions, res, respondNative: true });
        } else if (openAiBody.stream) {
          await handleStream({ ...dispatchOptions, res });
        } else {
          await handleNonStream({ ...dispatchOptions, res, respondNative: false });
        }
        attemptOutcome = 'ok';
      } catch (error) {
        lastError = error;
        abortCode = attemptAbort.signal.aborted && typeof attemptAbort.signal.reason?.code === 'string'
          ? attemptAbort.signal.reason.code
          : null;
        if (clientGone()) {
          attemptOutcome = 'client_abort';
          lastFailure = describeFailure(clientAbortError());
          lastDecision = decideFailure(lastFailure, {});
          lastDecision.action = 'stop';
          lastDecision.stopReason = 'client_cancelled';
          attemptFailure = lastFailure;
          attemptDecision = lastDecision;
          retry = false;
        } else if (outOfTime()) {
          attemptOutcome = 'deadline';
          lastError = deadlineError(deadlineMs);
          lastFailure = describeFailure(lastError);
          lastDecision = decideFailure(lastFailure, {});
          attemptFailure = lastFailure;
          attemptDecision = lastDecision;
          retry = false;
        } else {
          const observed = describeFailure(error);
          const failure = {
            ...observed,
            // Local flow/timeout codes stay visible in the legacy journal reason.
            kind: abortCode ?? observed.kind,
            accountId: observed.accountId ?? account.id,
            generation: observed.generation ?? attemptGeneration,
          };
          lastFailure = failure;
          // Keep a plain read/parse error's identity, but carry the classification with it.
          if (!(error instanceof UpstreamError)) annotateFailure(error, failure);
          decision = decideFailure(failure, {
            headersCommitted: res.headersSent === true,
            authRetryUsed: authRetried.has(account.id),
            canRetryCredential: budget.canTakeGeneration(account.id),
            phase: failure.phase,
          });
          lastDecision = decision;
          attemptFailure = failure;
          attemptDecision = decision;
          attemptOutcome = error?.reported === true
            ? 'stream_failed'
            : (abortCode === 'first_frame_timeout' || abortCode === 'idle_timeout') ? abortCode
              : abortCode === 'attempt_timeout' ? 'attempt_timeout'
                : decision.outcome;
          attemptFailures.push(failure);

          const fresh = freshGenerationFor(account.id);
          const generationCurrent = !fresh.known
            || (fresh.generation !== null && fresh.generation === attemptGeneration);
          if (decision.sharedEffect !== 'none') {
            stateEffect = generationCurrent
              ? applySharedEffect(pool, decision, {
                account, generation: attemptGeneration, context: attemptContext, config, now: Date.now(),
              })
              : { applied: false, effect: 'stale_generation' };
          }

          if (decision.budget === 'shared') {
            sharedRemaining -= 1;
            if (sharedRemaining <= 0) {
              decision.action = 'stop';
              decision.stopReason = decision.stopReason ?? 'shared_budget_spent';
            }
          }

          if (decision.action === 'stop') {
            retry = false;
            stopReason = decision.stopReason ?? 'stopped';
          } else if (decision.action === 'retry_credential') {
            upstream.forceRefresh?.(account);
            authRetried.add(account.id);
            retry = true;
            retrySame = true;
          } else if (decision.action === 'retry_replaced') {
            // No wire dispatch happened: the same path now carries new material. Re-select once.
            if (replacedRetried.has(account.id)) {
              retry = false;
              decision.stopReason = 'credential_replaced_again';
            } else {
              replacedRetried.add(account.id);
              tried.delete(account.id);
              retry = true;
              retrySame = false;
            }
          } else {
            retry = true;
            retrySame = false;
          }
        }
      } finally {
        flow?.dispose();
        requestSignal.removeEventListener('abort', forwardAbort);
        if (attemptTimer) clearTimeout(attemptTimer);
      }

      status = attemptOutcome === 'ok'
        ? 200
        : (attemptOutcome === 'client_abort' ? null : (attemptFailure?.publicStatus ?? 502));
      logger.info('attempt.timing', {
        requestId,
        attempt,
        account: accountLabel(account),
        stream: openAiBody.stream === true,
        native: respondNative === true,
        outcome: attemptOutcome,
        status,
        observedStatus: attemptFailure?.observedStatus ?? null,
        reason: attemptFailure ? `${attemptFailure.kind}:${attemptFailure.publicStatus}` : null,
        ...(attemptFailure ? failureFields(attemptFailure) : {}),
        decision: attemptDecision?.action ?? null,
        decisionReason: attemptDecision?.reason ?? null,
        policyVersion: POLICY_VERSION,
        sharedEffect: stateEffect?.effect ?? 'none',
        sharedScope: attemptDecision?.sharedScope ?? null,
        retry: retry === true,
        stopReason: attemptDecision?.stopReason ?? null,
        modelRequested: ctx.modelRequested,
        modelOutbound: ctx.modelOutbound,
        modelReported: ctx.modelReported,
        egress: attemptContext?.egressAlias ?? 'direct',
        generationPost: budget.displacementFor(account.id).generation,
        oauthPost: budget.displacementFor(account.id).oauth,
        projectPost: budget.displacementFor(account.id).project,
        prepMs: timing.prepMs,
        firstFrameMs: timing.firstFrameMs,
        totalMs: Date.now() - attemptStartedAt,
      });

      if ((attemptOutcome === abortCode || attemptOutcome === 'stream_failed')
        && (abortCode === 'first_frame_timeout' || abortCode === 'idle_timeout')) {
        logger.warn('rotation.stall', {
          requestId,
          account: accountLabel(account),
          attempt,
          kind: abortCode,
          timeoutMs: abortCode === 'first_frame_timeout' ? flowTimeouts.firstMeaningfulFrameMs : flowTimeouts.idleMs,
          rotatable: attemptOutcome === abortCode,
          policyVersion: POLICY_VERSION,
        });
      }

      if (attemptOutcome === 'ok') {
        pool.recoverProbe(selection, { generation: attemptGeneration });
        requestOutcome = 'ok';
        status = 200;
        ctx.finish({ route: 'agy', reason: null });
        return;
      }
      if (attemptOutcome === 'client_abort') {
        pool.releaseProbe(selection);
        throw lastError;
      }
      if (!retry) {
        pool.releaseProbe(selection);
        break;
      }
      if (retrySame) {
        // The recovery-probe lease spans the forced-auth retry of the same credential.
        continue;
      }
      pool.releaseProbe(selection);
      account = null;
      selection = null;
    }

    if (!stopReason && !exhaustion) stopReason = 'iteration_bound';

    // Pool exhausted: last-resort Vertex relay before giving up, inside the same budget.
    if (!clientGone() && !outOfTime()
      && await tryVertexFallback({ config, logger, openAiBody, res, signal: requestSignal, deadlineAt, respondNative, lastError, requestId, call: ctx, budget })) {
      requestOutcome = 'vertex_fallback';
      status = 200;
      return;
    }
    if (clientGone()) { requestOutcome = 'client_abort'; throw clientAbortError(); }
    if (outOfTime()) { requestOutcome = 'deadline'; throw deadlineError(deadlineMs); }

    const finalError = finalPoolError({
      storeError, accounts, exhaustion, attemptFailures, lastError, lastFailure, stopReason,
    });
    ctx.syncFromBudget(budget);
    ctx.finish({ reason: headerReasonFor(finalError), stopReason: lastDecision?.stopReason ?? stopReason });
    throw finalError;
  } catch (error) {
    ctx.syncFromBudget(budget);
    if (clientGone()) {
      requestOutcome = 'client_abort';
      status = null; // nobody is left to receive a status
    } else {
      requestOutcome = outOfTime() ? 'deadline' : 'failed';
      const finalFailure = describeFailure(error);
      status = error instanceof UpstreamError
        ? error.publicStatus
        : (Number.isInteger(finalFailure?.publicStatus) ? finalFailure.publicStatus : (error.status === 400 ? 400 : 502));
      ctx.finish({ reason: headerReasonFor(error), stopReason: lastDecision?.stopReason ?? stopReason });
    }
    throw error;
  } finally {
    // Last-resort lease release: every normal path releases earlier, this covers an exception
    // between selection and the attempt-level cleanup. Recovery never happens on release.
    if (selection && typeof pool.releaseProbe === 'function') pool.releaseProbe(selection);
    clearTimeout(deadlineTimer);
    logger.info('request.timing', {
      requestId,
      outcome: requestOutcome,
      status,
      attempts: budget.counts().accountAttempts,
      generationPosts: budget.counts().generation,
      oauthPosts: budget.counts().oauth,
      projectPosts: budget.counts().project,
      refreshJoins: budget.counts().refreshJoins,
      maxGenerationPosts: budget.counts().maxGeneration,
      reason: requestOutcome === 'ok' ? null : (requestOutcome === 'client_abort' ? 'client_disconnected' : failureReason(lastError)),
      totalMs: Date.now() - startedAt,
      deadlineMs,
      route: ctx.route,
      policyVersion: POLICY_VERSION,
      stopReason: ctx.stopReason ?? stopReason,
      exhausted: exhaustion ? {
        tried: exhaustion.counts.tried,
        credentialBlocked: exhaustion.counts.credentialBlocked,
        quotaGated: exhaustion.counts.quotaGated,
        egressGated: exhaustion.counts.egressGated,
        resourceGated: exhaustion.counts.resourceGated,
        probeBusy: exhaustion.counts.probeBusy,
      } : null,
    });
  }
}

/**
 * The final response must describe what actually happened. A fabricated 429 is never produced
 * because selection returned null: 429 needs quota evidence explaining every candidate, and mixed,
 * unknown or blocked pools answer with an explicit service failure.
 */
function finalPoolError({ storeError, accounts, exhaustion, attemptFailures, lastError, lastFailure, stopReason }) {
  if (storeError) {
    return new UpstreamError('no upstream credentials are available', {
      status: 503, origin: 'local', phase: 'credential_load', reason: 'invalid_local_config',
      scope: 'request', evidence: 'unclassified_error', publicStatus: 503,
    });
  }
  if (accounts.length === 0) {
    return new UpstreamError('no upstream credentials are available', {
      status: 503, origin: 'local', phase: 'credential_load', reason: 'invalid_local_config',
      scope: 'request', evidence: 'unclassified_error', publicStatus: 503,
    });
  }
  if (exhaustion) {
    const exclusions = exhaustion.exclusions ?? [];
    const quotaOnly = exclusions.length > 0
      && exclusions.every((entry) => entry.code === 'quota_gated')
      && (attemptFailures.length === 0 || attemptFailures.every((failure) => failure.reason === 'rate_limit_unknown_scope'
        || failure.reason === 'scoped_quota'
        || failure.reason === 'account_restricted'
        || failure.reason === 'project_restricted'
        || failure.reason === 'provider_unavailable'));
    if (lastError) {
      // A real observed failure is kept unless turning it into 429 would misdescribe a mixed pool:
      // another observed failure, or an exclusion reason that is not an observed 429/quota gate.
      const mixedExclusions = exclusions.some((entry) => entry.code !== 'tried' && entry.code !== 'quota_gated');
      const mixedAfterRateLimit = lastFailure?.reason === 'rate_limit_unknown_scope'
        && (attemptFailures.some((failure) => failure.reason !== 'rate_limit_unknown_scope') || mixedExclusions);
      if (!mixedAfterRateLimit) {
        if (lastError.reason === 'rate_limit_unknown_scope') {
          const untils = attemptFailures.map((failure) => failure.retryAt).filter((until) => Number.isFinite(until));
          if (untils.length > 0) {
            // The earliest observed eligibility time, not a local cooldown guess.
            lastError.retryAt = Math.min(...untils);
            lastError.retryAtSource = 'retry_after';
          }
        }
        return lastError;
      }
      return new UpstreamError('upstream attempts ended with mixed failures', {
        status: 503, origin: 'local', phase: 'dispatch', reason: 'unknown',
        scope: 'request', evidence: 'pool_gate', publicStatus: 503,
      });
    }
    if (quotaOnly) {
      const untils = exclusions.map((entry) => entry.until).filter((until) => Number.isFinite(until));
      const retryAt = untils.length === exclusions.length ? Math.min(...untils) : null;
      return new UpstreamError('no eligible upstream account: quota gate', {
        status: 429, origin: 'generation', phase: 'dispatch', reason: 'account_restricted',
        scope: 'account', evidence: 'pool_gate', publicStatus: 429,
        retryAt, retryAtSource: retryAt ? 'retry_after' : null,
      });
    }
    if (exclusions.length > 0 && exclusions.every((entry) => entry.code === 'credential_blocked')) {
      return new UpstreamError('no eligible upstream credential', {
        status: 503, origin: 'oauth', phase: 'refresh', reason: 'credential_blocked',
        scope: 'credential', evidence: 'oauth_invalid_grant', publicStatus: 503,
      });
    }
    if (exclusions.length > 0 && exclusions.every((entry) => entry.code === 'egress_gated')) {
      return new UpstreamError('no eligible upstream account: egress gate', {
        status: 503, origin: 'egress', phase: 'connect', reason: 'egress_unavailable',
        scope: 'egress', evidence: 'egress_connect', publicStatus: 503,
      });
    }
    if (exclusions.length > 0 && exclusions.every((entry) => entry.code === 'probe_busy')) {
      return new UpstreamError('no eligible upstream account: recovery probe is busy', {
        status: 503, origin: 'generation', phase: 'dispatch', reason: 'probe_lost',
        scope: 'request', evidence: 'probe_ownership', publicStatus: 503,
      });
    }
    return new UpstreamError('no eligible upstream account', {
      status: 503, origin: 'local', phase: 'dispatch', reason: 'unknown',
      scope: 'request', evidence: 'pool_gate', publicStatus: 503,
    });
  }
  if (stopReason === 'deadline') {
    return lastError ?? new UpstreamError('request deadline exceeded', {
      status: 504, origin: 'caller', phase: 'client', reason: 'deadline', scope: 'request',
      evidence: 'request_deadline', publicStatus: 504, kind: 'deadline',
    });
  }
  if (stopReason === 'shared_budget_spent'
    && attemptFailures.some((failure) => failure.reason === 'rate_limit_unknown_scope')
    && attemptFailures.some((failure) => failure.reason !== 'rate_limit_unknown_scope')) {
    // Mixed failures are not a proven quota exhaustion.
    return new UpstreamError('upstream attempts ended with mixed failures', {
      status: 503, origin: 'local', phase: 'dispatch', reason: 'unknown', scope: 'request',
      evidence: 'pool_gate', publicStatus: 503,
    });
  }
  if (lastError) return lastError;
  return new UpstreamError('upstream request failed', {
    status: 503, origin: 'local', phase: 'dispatch', reason: 'unknown', scope: 'request',
    evidence: 'unclassified_error', publicStatus: 503,
  });
}

/** Last-resort relay to the local Vertex proxy when every antigravity account failed. */
async function tryVertexFallback({ config, logger, openAiBody, res, signal, deadlineAt, respondNative, lastError, requestId, call, budget }) {
  const fb = config.fallback;
  if (!fb?.enabled || !fb.vertexUrl || respondNative || res.headersSent) return false;
  // Caller input and local configuration are not the pool being exhausted; never mask them with
  // another endpoint.
  if (describeFailure(lastError).reason === 'invalid_request'
    || describeFailure(lastError).reason === 'invalid_local_config') return false;
  if (!isGeminiFamily(openAiBody.model)) return false;
  // the fallback gets what is left of the request budget, never a fresh timeout of its own
  const remainingMs = deadlineAt - Date.now();
  if (!(remainingMs > 0)) return false;
  const timeoutMs = Math.min(Number.isFinite(fb.timeoutMs) && fb.timeoutMs > 0 ? fb.timeoutMs : remainingMs, remainingMs);
  logger.warn('vertex_fallback.attempt', { requestId, model: call?.modelRequested ?? 'unknown', poolError: failureReason(lastError) });
  try {
    const json = await generateViaVertexFallback({
      openAiBody, vertexUrl: fb.vertexUrl, timeoutMs, signal,
    });
    call?.syncFromBudget?.(budget);
    call?.finish?.({ route: 'vertex_fallback', reason: null });
    const headers = call?.headers?.() ?? {};
    if (openAiBody.stream) {
      const body = openAiJsonToStreamFrames(json, openAiBody.model);
      res.writeHead(200, {
        'content-type': 'text/event-stream', 'cache-control': 'no-cache',
        connection: 'keep-alive', 'content-length': Buffer.byteLength(body), ...headers,
      });
      res.end(body);
    } else {
      const body = JSON.stringify(json);
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
      res.end(body);
    }
    logger.warn('vertex_fallback.ok', { requestId, model: call?.modelRequested ?? 'unknown', route: 'vertex_fallback' });
    return true;
  } catch (error) {
    logger.warn('vertex_fallback.failed', { requestId, model: call?.modelRequested ?? 'unknown', reason: failureReason(error) });
    return false;
  }
}

/**
 * Yields the SSE lines of an upstream body, including a final line without a trailing newline:
 * a cut-off stream must not silently lose the frame that carries its finish reason.
 */
async function* sseLines(body) {
  const decoder = new TextDecoder('utf8');
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      yield buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer !== '') yield buffer.replace(/\r$/, '');
}

// Fixed counters distinguish rejected response shapes without retaining payloads.
function collectionShape() {
  return {
    endClass: 'error',
    frameCount: 0,
    candidateCount: 0,
    textFrames: 0,
    reasoningFrames: 0,
    toolFrames: 0,
    signatureOnlyFrames: 0,
    terminalSeen: false,
    wrappedError: false,
  };
}

/** Counts one parsed frame; `wrappedError` is specifically the wrapped (`response.error`) position. */
function observeFrameShape(frame, shape) {
  const wrapper = frame?.response ?? frame;
  const candidates = Array.isArray(wrapper?.candidates) ? wrapper.candidates : [];
  const parts = Array.isArray(candidates[0]?.content?.parts) ? candidates[0].content.parts : [];
  const hasText = parts.some((part) => typeof part?.text === 'string' && part.text !== '' && part.thought !== true);
  const hasReasoning = parts.some((part) => typeof part?.text === 'string' && part.text !== '' && part.thought === true);
  const hasTool = parts.some((part) => Boolean(part?.functionCall));
  const hasSignature = parts.some((part) => typeof part?.thoughtSignature === 'string' && part.thoughtSignature !== '');
  shape.frameCount += 1;
  shape.candidateCount = candidates.length;
  if (frame?.response?.error) shape.wrappedError = true;
  if (hasText) shape.textFrames += 1;
  if (hasReasoning) shape.reasoningFrames += 1;
  if (hasTool) shape.toolFrames += 1;
  if (hasSignature && !hasText && !hasReasoning && !hasTool) shape.signatureOnlyFrames += 1;
  if (rawFinishReason(frame) !== null) shape.terminalSeen = true;
}

// non-stream клиенту отдаём обычный JSON, но к апстриму идём стримом:
// generateContent собирает ответ целиком и на длинных текстах выходит за
// любой разумный таймаут, streamGenerateContent отдаёт те же данные первого
// токена за секунды. Функция склеивает дельты в один completion.
async function collectCompletion(options) {
  const shape = collectionShape();
  try {
    return await collectFrames(options, shape);
  } catch (error) {
    // one bounded line per rejected collection; the caller keeps the original error object
    options.logger.warn('chat.collect_failed', {
      requestId: options.requestId,
      account: accountLabel(options.account),
      ...shape,
      endClass: options.signal?.aborted === true ? 'abort' : shape.endClass,
    });
    throw error;
  }
}

async function readJsonBody(upstreamResponse, account, generation) {
  try {
    return await upstreamResponse.json();
  } catch (error) {
    throw malformedBody(account.id, generation, error);
  }
}

function validateNativeBody(json, account, generation) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw malformedShape(account.id, generation);
  const explicitError = explicitUpstreamError(json);
  if (explicitError) throw upstreamErrorFromJson(explicitError, account.id, { generation });
  const wrapper = json?.response ?? json;
  const blocked = Boolean(wrapper?.promptFeedback?.blockReason) && !wrapper?.candidates?.length;
  const terminal = rawFinishReason(json);
  if (terminal !== null && !isSuccessfulTerminal(terminal)) {
    throw unsuccessfulTerminal(account.id, terminal, generation);
  }
  // A prompt-level refusal is a documented successful outcome; a candidate without a terminal is not.
  if (terminal === null && !blocked) throw truncatedCompletion(account.id, generation);
  return wrapper;
}

async function collectFrames(options, shape) {
  const { upstream, openAiBody, account, signal, model, timing, flow, generation, budget, beforeDispatch, requestId } = options;
  const upstreamResponse = await upstream.generateStream({
    openAiBody, account, signal, budget, beforeDispatch, requestId,
  });
  timing.prepMs = Date.now() - timing.startedAt;
  // апстрим иногда отвечает обычным JSON даже на sse-эндпоинт: не ломаемся.
  // Обёртки без headers/body (mari-router) тоже встречаются - проверяем мягко.
  const hasHeaders = upstreamResponse.headers && typeof upstreamResponse.headers.get === "function";
  const type = hasHeaders ? upstreamResponse.headers.get("content-type") || "" : "";
  const hasStream = upstreamResponse.body && typeof upstreamResponse.body[Symbol.asyncIterator] === "function";
  if ((hasHeaders && !type.includes("text/event-stream")) || !hasStream) {
    const json = await readJsonBody(upstreamResponse, account, generation);
    shape.endClass = 'clean';
    observeFrameShape(json, shape);
    // an upstream error object is a failure, not an empty completion - bare or wrapped
    const explicitError = explicitUpstreamError(json);
    if (explicitError) throw upstreamErrorFromJson(explicitError, account.id, { generation });
    const wrapper = json?.response ?? json;
    const blocked = wrapper?.promptFeedback?.blockReason && !wrapper?.candidates?.length;
    const terminal = rawFinishReason(json);
    if (terminal !== null && !isSuccessfulTerminal(terminal)) throw unsuccessfulTerminal(account.id, terminal, generation);
    // a documented refusal or an explicit successful terminal, never the translate default
    if (terminal === null && !blocked) throw truncatedCompletion(account.id, generation);
    return antigravityToOpenAi(json, { model });
  }
  const indexRef = { count: 0, first: true };
  const toolCalls = new Map();
  let id = null;
  let content = '';
  let reasoning = '';
  let blocked = null;
  let finishReason = null;
  let usage = null;

  // A line is an explicit upstream error, a keepalive with nothing usable, or a delta.
  // Malformed JSON used to be skipped, which turned a broken stream into a successful empty
  // answer; it is a protocol failure now.
  const consume = (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let frame;
    try { frame = JSON.parse(payload); } catch { throw malformedFrame(account.id, generation); }
    observeFrameShape(frame, shape);
    // an explicit upstream error is a failure, not a keepalive - bare or in the response wrapper
    const explicitError = explicitUpstreamError(frame);
    if (explicitError) throw upstreamErrorFromJson(explicitError, account.id, { generation });
    const terminal = rawFinishReason(frame);
    if (terminal !== null && !isSuccessfulTerminal(terminal)) throw unsuccessfulTerminal(account.id, terminal, generation);
    const out = antigravityChunkToOpenAiChunk(frame, { model, indexRef });
    if (hasSignatureProgress(frame) || isMeaningfulChunk(out)) {
      // only real progress counts for the flow timers: a keepalive never satisfies the first wait
      timing.firstFrameMs ??= Date.now() - timing.startedAt;
      flow?.progress();
    }
    if (!out) return; // signature-only progress emits no client delta; keepalives do neither
    id ??= out.id;
    if (out.usage) usage = out.usage;
    const choice = out.choices && out.choices[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string') content += delta.content;
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
    if (typeof delta.refusal === 'string' && delta.refusal !== '') blocked = delta.refusal;
    for (const call of delta.tool_calls || []) {
      const slot = toolCalls.get(call.index) || { id: '', type: 'function', name: '', arguments: '' };
      if (call.id) slot.id = call.id;
      if (call.type) slot.type = call.type;
      // Gemini 3 tool replay needs the signature back on the next turn's functionCall parts
      if (call.thought_signature) slot.thought_signature = call.thought_signature;
      if (call.function?.name) slot.name += call.function.name;
      if (call.function?.arguments) slot.arguments += call.function.arguments;
      toolCalls.set(call.index, slot);
    }
    // only an explicit terminal frame counts as the end of a generation
    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
    }
  };

  for await (const line of sseLines(upstreamResponse.body)) {
    if (signal?.aborted) throw abortFailure(signal);
    consume(line);
  }
  // A normal EOF may still fail terminal validation; keep it distinct from a failed read/parse.
  shape.endClass = 'clean';

  if (id === null && !content && !reasoning && toolCalls.size === 0) {
    throw emptyStream(account.id, generation);
  }
  // A finished generation always carries a finishReason. Without one the body was cut short:
  // answering "stop" here handed the client a truncated answer as a complete one.
  if (finishReason === null) {
    throw truncatedCompletion(account.id, generation);
  }

  const message = { role: 'assistant', content: content || (toolCalls.size ? null : '') };
  if (blocked) message.refusal = blocked;
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.size) {
    message.tool_calls = [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, call]) => ({
        id: call.id || `call_${index}`,
        type: call.type || 'function',
        function: { name: call.name, arguments: call.arguments || '{}' },
        ...(call.thought_signature ? { thought_signature: call.thought_signature } : {}),
      }));
  }
  return {
    id: id || `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, logprobs: null, finish_reason: finishReason }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

async function handleNonStream({
  upstream, logger, account, openAiBody, res, signal, respondNative = false,
  timing, flow, requestId, call, budget, beforeDispatch, generation,
}) {
  if (!respondNative) {
    const openAiJson = await collectCompletion({
      upstream, logger, requestId, openAiBody, account, signal, model: openAiBody.model,
      timing, flow, call, budget, beforeDispatch, generation,
    });
    call?.syncFromBudget?.(budget);
    const body = JSON.stringify(openAiJson);
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      ...(call?.headers?.() ?? {}),
    });
    res.end(body);
    logger.info('chat.completed', {
      requestId,
      model: call?.modelRequested ?? 'unknown',
      effort: safeEffort(openAiBody.reasoning_effort ?? openAiBody.reasoning?.effort),
      account: accountLabel(account),
      promptTokens: openAiJson.usage.prompt_tokens,
      cachedTokens: openAiJson.usage.prompt_tokens_details?.cached_tokens ?? 0,
      completionTokens: openAiJson.usage.completion_tokens,
      blocked: Boolean(openAiJson.choices[0].message.refusal),
    });
    return;
  }
  // Native buffered lane: generateContent, one JSON body, no frames to measure. The first-frame and
  // idle timers deliberately do not apply here; the legacy attempt ladder and the request budget are
  // its only caps. Explicit-error and terminal validation now match the SSE collection.
  const upstreamResponse = await upstream.generate({
    openAiBody, account, signal, budget, beforeDispatch, requestId,
  });
  timing.prepMs = Date.now() - timing.startedAt;
  const json = await readJsonBody(upstreamResponse, account, generation);
  const wrapper = validateNativeBody(json, account, generation);
  const { antigravityToGeminiNative } = await import('../rewrite/gemini-native.js');
  const nativeJson = antigravityToGeminiNative(json);
  call?.syncFromBudget?.(budget);
  const body = JSON.stringify(nativeJson);
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...(call?.headers?.() ?? {}),
  });
  res.end(body);
  logger.info('native.completed', {
    requestId,
    model: call?.modelRequested ?? 'unknown',
    effort: safeEffort(openAiBody.reasoning_effort ?? openAiBody.reasoning?.effort),
    account: accountLabel(account),
    blocked: Boolean(wrapper?.promptFeedback?.blockReason),
  });
}

/** Waits for the client to drain, but stops as soon as the request is cancelled. */
function drainOrAbort(res, signal) {
  if (signal?.aborted) return Promise.reject(abortFailure(signal));
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.removeListener('drain', onDrain);
      res.removeListener('close', onClose);
      signal?.removeEventListener('abort', onAbort);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('client disconnected')); };
    const onAbort = () => { cleanup(); reject(abortFailure(signal)); };
    res.once('drain', onDrain);
    // a lost caller never drains: without this the pump parks and holds the upstream stream open
    res.once('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The client stream already carries the failure: it is reported to the caller of the attempt as a
 * failure of the request, but it must not be appended to (no second account's output, no retry).
 */
function reportedStreamFailure(error, accountId, generation) {
  if (error instanceof UpstreamError) {
    error.reported = true;
    if (error.generation == null) error.generation = generation;
    return error;
  }
  const code = typeof error?.code === 'string' ? error.code : null;
  const timedOut = code === 'first_frame_timeout' || code === 'idle_timeout' || code === 'attempt_timeout' || code === 'request_deadline';
  const wrapped = new UpstreamError('upstream stream failed', {
    status: timedOut ? 504 : 502,
    origin: 'protocol',
    phase: 'stream',
    reason: timedOut ? 'timeout' : 'unknown',
    scope: 'request',
    evidence: 'unclassified_error',
    publicStatus: timedOut ? 504 : 502,
    accountId,
    generation,
    kind: timedOut ? code : 'stream',
  });
  wrapped.reported = true;
  return wrapped;
}

async function handleStream({
  upstream, logger, account, openAiBody, res, signal, timing, flow, requestId,
  call, budget, beforeDispatch, generation,
}) {
  const upstreamResponse = await upstream.generateStream({
    openAiBody, account, signal, budget, beforeDispatch, requestId,
  });
  timing.prepMs = Date.now() - timing.startedAt;
  call?.syncFromBudget?.(budget);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...(call?.headers?.() ?? {}),
  });
  const indexRef = { count: 0, first: true };

  // manual pump: stream/pipeline auto-destroys the destination on error,
  // which would swallow the error frame we want to send (H4)
  let failed = null;
  let blocked = false;
  let terminalSeen = false;
  try {
    for await (const line of sseLines(upstreamResponse.body)) {
      if (signal?.aborted) throw abortFailure(signal);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let frame;
      try { frame = JSON.parse(payload); } catch { throw malformedFrame(account.id, generation); }
      // an explicit upstream error is a failure, not a quietly finished answer - bare or wrapped
      const explicitError = explicitUpstreamError(frame);
      if (explicitError) throw upstreamErrorFromJson(explicitError, account.id, { generation });
      const terminal = rawFinishReason(frame);
      // an unsuccessful or unknown terminal must never reach the client as a clean stop
      if (terminal !== null && !isSuccessfulTerminal(terminal)) throw unsuccessfulTerminal(account.id, terminal, generation);
      const openAiChunk = antigravityChunkToOpenAiChunk(frame, { model: openAiBody.model, indexRef });
      if (hasSignatureProgress(frame) || isMeaningfulChunk(openAiChunk)) {
        timing.firstFrameMs ??= Date.now() - timing.startedAt;
        flow?.progress();
      }
      if (openAiChunk) {
        if (openAiChunk.choices[0].finish_reason) terminalSeen = true;
        blocked ||= Boolean(openAiChunk.choices[0].delta?.refusal);
        if (!res.write(`data: ${JSON.stringify(openAiChunk)}\n\n`)) {
          await drainOrAbort(res, signal); // backpressure
        }
      }
    }
    // A generation ends with an explicit terminal frame. A body that just stops must not be turned
    // into a success-only [DONE]: the caller would take a truncated answer as a complete one.
    if (!terminalSeen) throw truncatedCompletion(account.id, generation);
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    failed = error;
  }
  if (failed) {
    logger.warn('stream.failed', {
      requestId,
      model: call?.modelRequested ?? 'unknown',
      account: accountLabel(account),
      reason: failureReason(failed),
      ...failureFields(describeFailure(failed)),
    });
    if (!res.writableEnded && !res.destroyed) {
      const detail = failed instanceof UpstreamError ? failed.message : publicFailureText(describeFailure(failed).reason);
      const message = `upstream stream failed: ${detail} (ref ${requestId})`;
      res.write(`data: ${JSON.stringify({ error: { message, type: 'server_error' } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
    throw reportedStreamFailure(failed, account.id, generation);
  }
  logger.info('chat.streamed', {
    requestId,
    model: call?.modelRequested ?? 'unknown',
    effort: safeEffort(openAiBody.reasoning_effort ?? openAiBody.reasoning?.effort),
    account: accountLabel(account),
    blocked,
  });
}
