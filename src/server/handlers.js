import { antigravityToOpenAi, antigravityChunkToOpenAiChunk } from '../rewrite/openai-translate.js';
import { abortFailure, UpstreamError, upstreamErrorFromJson } from '../upstream/upstream-client.js';
import { generateViaVertexFallback, isGeminiFamily, openAiJsonToStreamFrames } from '../upstream/vertex-fallback.js';
import { accountLabel } from '../utils/alias.js';

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

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

export function errorResponse(res, status, message, type = 'invalid_request_error') {
  const body = JSON.stringify({ error: { message, type, code: status } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
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

/** A caller-supplied id is correlation sugar only: short, printable, no control characters. */
function requestIdFor(req) {
  const given = req?.headers?.['x-request-id'];
  if (typeof given === 'string') {
    const clean = given.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 64);
    if (clean) return clean;
  }
  return `req-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/**
 * Payload-free failure classification for the journal: a structured kind and status, never an
 * upstream message body (those echo prompts), never a token, path or email.
 */
export function failureReason(error) {
  if (!error) return null;
  if (error instanceof UpstreamError) return `${error.kind}:${error.status}`;
  if (typeof error.code === 'string') return error.code;
  return error.name || 'error';
}

function clientAbortError() {
  return new UpstreamError('client disconnected', { status: 499, kind: 'client_abort' });
}

function deadlineError(deadlineMs) {
  return new UpstreamError(`request deadline of ${deadlineMs}ms exceeded`, { status: 504, kind: 'deadline' });
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

function unsuccessfulTerminal(accountId, finishReason) {
  return new UpstreamError(`upstream finished with an unsuccessful finish reason: ${typeof finishReason === 'string' ? finishReason : 'invalid type'}`, {
    status: 502, accountId, kind: 'terminal',
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

/**
 * Runs an OpenAI-shaped request through the pool with rotation on quota/auth.
 * attemptTimeoutsMs (header x-attempt-timeouts-ms, non-stream only): the i-th account attempt is
 * capped at attemptTimeoutsMs[i] (the last value repeats), clamped to what is left of the request
 * deadline; the request then moves on to the next account and, once the pool is spent, the Vertex
 * relay answers inside the same budget. A caller that disconnects, or a spent deadline, is not an
 * upstream failure: the account is not cooled down and no further attempt starts.
 * The flow timers (rotation.firstMeaningfulFrameTimeoutMs / rotation.idleTimeoutMs) cut an attempt
 * that holds its socket open without progress; they rotate only while nothing has been written to
 * the caller, because a started client stream can never receive another account's output.
 */
export async function handleWithRotation({ pool, store, upstream, config, logger, openAiBody, req, res, signal, respondNative = false, attemptTimeoutsMs = [] }) {
  const requestId = requestIdFor(req);
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

  let lastError = null;
  let accounts = [];
  try {
    accounts = store.readAll();
  } catch (error) {
    // missing/corrupt credential files: the pool is empty — still fall back
    lastError = error;
  }
  // 2026-10-19: перебор ВСЕХ аккаунтов, а не трёх. Мари не должна видеть 429,
  // пока в пуле есть живые аккаунты (7 аккаунтов, 3 попытки = 4 живых простаивали).
  const maxAttempts = accounts.length;
  const tried = new Set();
  let attempts = 0;
  let requestOutcome = 'failed';
  let status = 502;

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // a caller that hung up, or a spent budget, never starts another account
      if (clientGone()) { requestOutcome = 'client_abort'; throw clientAbortError(); }
      if (outOfTime()) { requestOutcome = 'deadline'; lastError = deadlineError(deadlineMs); break; }
      const account = pool.pick(accounts, tried);
      if (!account) {
        // all accounts cooling down: fail fast, do not hammer the exhausted pool
        lastError = new UpstreamError('all accounts are cooling down (rate limited)', { status: 429, kind: 'quota' });
        status = 429;
        break;
      }
      tried.add(account.id);
      attempts = attempt + 1;
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
      // The flow watchdog exists where there is a frame stream to measure: the client SSE lane and
      // the SSE collection of a non-stream request. Native buffered generateContent has no frames,
      // so it keeps only the ladder and the total budget (see README, "native lane").
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
      let retry = false;
      let abortCode = null;
      try {
        if (openAiBody.stream) {
          await handleStream({ upstream, config, logger, account, openAiBody, res, signal: attemptSignal, timing, flow, requestId });
        } else {
          await handleNonStream({ upstream, logger, account, openAiBody, res, signal: attemptSignal, respondNative, timing, flow, requestId });
        }
        attemptOutcome = 'ok';
      } catch (error) {
        lastError = error;
        abortCode = attemptAbort.signal.aborted && typeof attemptAbort.signal.reason?.code === 'string'
          ? attemptAbort.signal.reason.code
          : null;
        if (clientGone()) {
          // the caller hung up: nothing to cool down and nobody left to answer
          attemptOutcome = 'client_abort';
        } else if (outOfTime()) {
          attemptOutcome = 'deadline';
          lastError = deadlineError(deadlineMs);
        } else if (error?.reported === true) {
          // the client stream already carries the failure frame: nothing may be appended to it and
          // no other account's output may be mixed into it
          attemptOutcome = 'stream_failed';
        } else if (abortCode === 'first_frame_timeout' || abortCode === 'idle_timeout') {
          // flow-aware cut: the upstream held its socket open without progress
          attemptOutcome = abortCode;
          const timeoutMs = abortCode === 'first_frame_timeout' ? flowTimeouts.firstMeaningfulFrameMs : flowTimeouts.idleMs;
          lastError = new UpstreamError(
            abortCode === 'first_frame_timeout'
              ? `upstream sent no meaningful frame within ${timeoutMs}ms`
              : `upstream stalled for ${timeoutMs}ms after making progress`,
            { status: 504, accountId: account.id, kind: 'timeout' },
          );
          // the next account may answer only while the caller has received nothing yet
          retry = !res.headersSent;
        } else if (attemptAbort.signal.aborted) {
          // a hung upstream: the next untried account gets the rest of the client's patience
          attemptOutcome = 'attempt_timeout';
          lastError = new UpstreamError(`upstream attempt timed out after ${attemptMs}ms`, { status: 504, accountId: account.id, kind: 'timeout' });
          logger.warn('rotation.attempt_timeout', { requestId, account: accountLabel(account), attempt, timeoutMs: attemptMs });
          retry = true;
        } else if (error instanceof UpstreamError && error.kind === 'quota') {
          attemptOutcome = 'quota';
          pool.cooldown(account.id, config.rotation.cooldownMs, accountLabel(account));
          logger.warn('rotation.quota', { requestId, account: accountLabel(account), attempt });
          retry = true;
        } else if (error instanceof UpstreamError && error.kind === 'auth') {
          attemptOutcome = 'auth';
          upstream.invalidate(account.id);
          logger.warn('rotation.auth', { requestId, account: accountLabel(account), attempt });
          retry = true;
        } else if (error instanceof UpstreamError && (error.status === 502 || error.status === 504) && !res.headersSent) {
          // 2026-10-17: transient lane/proxy failures (502/504 before any bytes were written)
          // must fail over to the next account instead of surfacing a break to the client.
          // A dead Mullvad lane on the sticky account otherwise aborts every request for
          // the whole cooldown window.
          attemptOutcome = 'transient';
          pool.cooldown(account.id, Math.min(config.rotation.cooldownMs, 60_000), accountLabel(account));
          logger.warn('rotation.transient', {
            requestId, account: accountLabel(account), attempt, status: error.status,
          });
          retry = true;
        }
      } finally {
        flow?.dispose();
        requestSignal.removeEventListener('abort', forwardAbort);
        if (attemptTimer) clearTimeout(attemptTimer);
      }
      // a flow stall is one category whether or not it could still rotate
      if ((attemptOutcome === abortCode || attemptOutcome === 'stream_failed')
        && (abortCode === 'first_frame_timeout' || abortCode === 'idle_timeout')) {
        logger.warn('rotation.stall', {
          requestId,
          account: accountLabel(account),
          attempt,
          kind: abortCode,
          timeoutMs: abortCode === 'first_frame_timeout' ? flowTimeouts.firstMeaningfulFrameMs : flowTimeouts.idleMs,
          rotatable: attemptOutcome === abortCode,
        });
      }
      status = attemptOutcome === 'ok' ? 200 : (attemptOutcome === 'client_abort' ? null : (lastError instanceof UpstreamError ? lastError.status : 502));
      logger.info('attempt.timing', {
        requestId,
        attempt,
        account: accountLabel(account),
        stream: openAiBody.stream === true,
        outcome: attemptOutcome,
        status,
        reason: attemptOutcome === 'ok' ? null : (attemptOutcome === 'client_abort' ? 'client_disconnected' : failureReason(lastError)),
        prepMs: timing.prepMs,
        firstFrameMs: timing.firstFrameMs,
        totalMs: Date.now() - attemptStartedAt,
      });
      if (attemptOutcome === 'ok') { requestOutcome = 'ok'; return; }
      if (attemptOutcome === 'client_abort') throw lastError;
      if (!retry) break;
    }

    // Pool exhausted: last-resort Vertex relay before giving up, inside the same budget.
    if (!clientGone() && !outOfTime()
      && await tryVertexFallback({ config, logger, openAiBody, res, signal: requestSignal, deadlineAt, respondNative, lastError, requestId })) {
      requestOutcome = 'vertex_fallback';
      status = 200;
      return;
    }
    if (clientGone()) { requestOutcome = 'client_abort'; throw clientAbortError(); }
    if (outOfTime()) { requestOutcome = 'deadline'; throw deadlineError(deadlineMs); }
    throw lastError ?? new UpstreamError('no accounts available', { status: 502 });
  } catch (error) {
    if (clientGone()) {
      requestOutcome = 'client_abort';
      status = null; // nobody is left to receive a status
    } else {
      requestOutcome = outOfTime() ? 'deadline' : 'failed';
      status = error instanceof UpstreamError ? error.status : (error.status === 400 ? 400 : 502);
    }
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
    logger.info('request.timing', {
      requestId, outcome: requestOutcome, status, attempts,
      reason: requestOutcome === 'ok' ? null : (requestOutcome === 'client_abort' ? 'client_disconnected' : failureReason(lastError)),
      totalMs: Date.now() - startedAt, deadlineMs,
    });
  }
}

/** Last-resort relay to the local Vertex proxy when every antigravity account failed. */
async function tryVertexFallback({ config, logger, openAiBody, res, signal, deadlineAt, respondNative, lastError, requestId }) {
  const fb = config.fallback;
  if (!fb?.enabled || !fb.vertexUrl || respondNative || res.headersSent) return false;
  if (!isGeminiFamily(openAiBody.model)) return false;
  // the fallback gets what is left of the request budget, never a fresh timeout of its own
  const remainingMs = deadlineAt - Date.now();
  if (!(remainingMs > 0)) return false;
  const timeoutMs = Math.min(Number.isFinite(fb.timeoutMs) && fb.timeoutMs > 0 ? fb.timeoutMs : remainingMs, remainingMs);
  logger.warn('vertex_fallback.attempt', { requestId, model: openAiBody.model, poolError: failureReason(lastError) });
  try {
    const json = await generateViaVertexFallback({
      openAiBody, vertexUrl: fb.vertexUrl, timeoutMs, signal,
    });
    if (openAiBody.stream) {
      const body = openAiJsonToStreamFrames(json, openAiBody.model);
      res.writeHead(200, {
        'content-type': 'text/event-stream', 'cache-control': 'no-cache',
        connection: 'keep-alive', 'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    } else {
      const body = JSON.stringify(json);
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    }
    logger.warn('vertex_fallback.ok', { requestId, model: openAiBody.model });
    return true;
  } catch (error) {
    logger.warn('vertex_fallback.failed', { requestId, model: openAiBody.model, reason: failureReason(error) });
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

function malformedFrame(accountId) {
  return new UpstreamError('upstream sent a malformed SSE frame', { status: 502, accountId, kind: 'malformed' });
}

function truncatedCompletion(accountId) {
  return new UpstreamError('upstream response ended without a finish reason (truncated)', {
    status: 502, accountId, kind: 'truncated',
  });
}

// non-stream клиенту отдаём обычный JSON, но к апстриму идём стримом:
// generateContent собирает ответ целиком и на длинных текстах выходит за
// любой разумный таймаут, streamGenerateContent отдаёт те же данные первого
// токена за секунды. Функция склеивает дельты в один completion.
async function collectCompletion({ upstream, openAiBody, account, signal, model, timing, flow }) {
  const upstreamResponse = await upstream.generateStream({ openAiBody, account, signal });
  timing.prepMs = Date.now() - timing.startedAt;
  // апстрим иногда отвечает обычным JSON даже на sse-эндпоинт: не ломаемся.
  // Обёртки без headers/body (mari-router) тоже встречаются - проверяем мягко.
  const hasHeaders = upstreamResponse.headers && typeof upstreamResponse.headers.get === "function";
  const type = hasHeaders ? upstreamResponse.headers.get("content-type") || "" : "";
  const hasStream = upstreamResponse.body && typeof upstreamResponse.body[Symbol.asyncIterator] === "function";
  if ((hasHeaders && !type.includes("text/event-stream")) || !hasStream) {
    const json = await upstreamResponse.json();
    // an upstream error object is a failure, not an empty completion
    if (json?.error) throw upstreamErrorFromJson(json.error, account.id);
    const wrapper = json?.response ?? json;
    const blocked = wrapper?.promptFeedback?.blockReason && !wrapper?.candidates?.length;
    const terminal = rawFinishReason(json);
    if (terminal !== null && !isSuccessfulTerminal(terminal)) throw unsuccessfulTerminal(account.id, terminal);
    // a documented refusal or an explicit successful terminal, never the translate default
    if (terminal === null && !blocked) throw truncatedCompletion(account.id);
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
    try { frame = JSON.parse(payload); } catch { throw malformedFrame(account.id); }
    if (frame?.error) throw upstreamErrorFromJson(frame.error, account.id);
    const terminal = rawFinishReason(frame);
    if (terminal !== null && !isSuccessfulTerminal(terminal)) throw unsuccessfulTerminal(account.id, terminal);
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

  if (id === null && !content && !reasoning && toolCalls.size === 0) {
    throw new Error('upstream stream produced no frames');
  }
  // A finished generation always carries a finishReason. Without one the body was cut short:
  // answering "stop" here handed the client a truncated answer as a complete one.
  if (finishReason === null) {
    throw truncatedCompletion(account.id);
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

async function handleNonStream({ upstream, logger, account, openAiBody, res, signal, respondNative = false, timing, flow, requestId }) {
  if (!respondNative) {
    const openAiJson = await collectCompletion({ upstream, openAiBody, account, signal, model: openAiBody.model, timing, flow });
    const body = JSON.stringify(openAiJson);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    logger.info('chat.completed', {
      requestId,
      model: openAiBody.model,
      effort: openAiBody.reasoning_effort ?? openAiBody.reasoning?.effort ?? null,
      account: accountLabel(account),
      promptTokens: openAiJson.usage.prompt_tokens,
      cachedTokens: openAiJson.usage.prompt_tokens_details?.cached_tokens ?? 0,
      completionTokens: openAiJson.usage.completion_tokens,
      blocked: Boolean(openAiJson.choices[0].message.refusal),
    });
    return;
  }
  // Native buffered lane: generateContent, one JSON body, no frames to measure. The first-frame and
  // idle timers deliberately do not apply here (nothing tells a JSON chunk from a keepalive); the
  // legacy attempt ladder and the request budget are its only caps. See README.
  const upstreamResponse = await upstream.generate({ openAiBody, account, signal });
  timing.prepMs = Date.now() - timing.startedAt;
  const json = await upstreamResponse.json();
  const { antigravityToGeminiNative } = await import('../rewrite/gemini-native.js');
  const nativeJson = antigravityToGeminiNative(json);
  const body = JSON.stringify(nativeJson);
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
  logger.info('native.completed', {
    requestId,
    model: openAiBody.model,
    effort: openAiBody.reasoning_effort ?? openAiBody.reasoning?.effort ?? null,
    account: accountLabel(account),
    blocked: Boolean(nativeJson?.promptFeedback?.blockReason),
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
function reportedStreamFailure(error, accountId) {
  if (error instanceof UpstreamError) {
    error.reported = true;
    return error;
  }
  const code = typeof error?.code === 'string' ? error.code : null;
  const timedOut = code === 'first_frame_timeout' || code === 'idle_timeout' || code === 'attempt_timeout' || code === 'request_deadline';
  const wrapped = new UpstreamError(error?.message ?? 'upstream stream failed', {
    status: timedOut ? 504 : 502,
    accountId,
    kind: code ?? 'stream',
  });
  wrapped.reported = true;
  return wrapped;
}

async function handleStream({ upstream, logger, account, openAiBody, res, signal, timing, flow, requestId }) {
  const upstreamResponse = await upstream.generateStream({ openAiBody, account, signal });
  timing.prepMs = Date.now() - timing.startedAt;
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
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
      try { frame = JSON.parse(payload); } catch { throw malformedFrame(account.id); }
      // an explicit upstream error is a failure, not a quietly finished answer
      if (frame?.error) throw upstreamErrorFromJson(frame.error, account.id);
      const terminal = rawFinishReason(frame);
      // an unsuccessful or unknown terminal must never reach the client as a clean stop
      if (terminal !== null && !isSuccessfulTerminal(terminal)) throw unsuccessfulTerminal(account.id, terminal);
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
    if (!terminalSeen) throw truncatedCompletion(account.id);
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    failed = error;
  }
  if (failed) {
    logger.warn('stream.failed', {
      requestId, model: openAiBody.model, account: accountLabel(account), reason: failureReason(failed),
    });
    if (!res.writableEnded && !res.destroyed) {
      res.write(`data: ${JSON.stringify({ error: { message: `upstream stream failed: ${failed.message}`, type: 'server_error' } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
    throw reportedStreamFailure(failed, account.id);
  }
  logger.info('chat.streamed', {
    requestId,
    model: openAiBody.model,
    effort: openAiBody.reasoning_effort ?? openAiBody.reasoning?.effort ?? null,
    account: accountLabel(account),
    blocked,
  });
}
