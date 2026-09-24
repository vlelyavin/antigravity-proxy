import { antigravityToOpenAi, antigravityChunkToOpenAiChunk } from '../rewrite/openai-translate.js';
import { modelsPayload } from '../rewrite/models.js';
import { UpstreamError } from '../upstream/upstream-client.js';
import { generateViaVertexFallback, isGeminiFamily, openAiJsonToStreamFrames } from '../upstream/vertex-fallback.js';

import { createHash, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';

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

/**
 * Runs an OpenAI-shaped request through the pool with rotation on quota/auth.
 * attemptTimeoutsMs (header x-attempt-timeouts-ms, non-stream only): the i-th account attempt is cut
 * after attemptTimeoutsMs[i] (the last value repeats) and the request moves on to the next account;
 * once the pool is spent, the Vertex relay answers within the client's own deadline.
 */
export async function handleWithRotation({ pool, store, upstream, config, logger, openAiBody, req, res, signal, respondNative = false, attemptTimeoutsMs = [] }) {
  let lastError = null;
  let accounts = [];
  try {
    accounts = store.readAll();
  } catch (error) {
    // missing/corrupt credential files: the pool is empty — still fall back
    lastError = error;
  }
  const maxAttempts = Math.min(accounts.length, 3);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const account = pool.pick(accounts);
    if (!account) {
      // all accounts cooling down: fail fast, do not hammer the exhausted pool
      lastError = new UpstreamError('all accounts are cooling down (rate limited)', { status: 429, kind: 'quota' });
      break;
    }
    const timeoutMs = openAiBody.stream ? null : attemptTimeoutsMs[Math.min(attempt, attemptTimeoutsMs.length - 1)];
    const attemptSignal = timeoutMs
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean))
      : signal;
    try {
      if (openAiBody.stream) {
        await handleStream({ upstream, config, logger, account, openAiBody, res, signal });
      } else {
        await handleNonStream({ upstream, config, logger, account, openAiBody, res, signal: attemptSignal, respondNative });
      }
      return;
    } catch (error) {
      lastError = error;
      if (timeoutMs && attemptSignal.aborted && !signal?.aborted) {
        // a hung upstream: the next account (round-robin) gets the rest of the client's patience
        lastError = new UpstreamError(`upstream attempt timed out after ${timeoutMs}ms`, { status: 504, accountId: account.id, kind: 'timeout' });
        logger.warn('rotation.attempt_timeout', { account: account.email || account.id, attempt, timeoutMs });
        continue;
      }
      if (error instanceof UpstreamError) {
        if (error.kind === 'quota') {
          pool.cooldown(account.id, config.rotation.cooldownMs);
          logger.warn('rotation.quota', { account: account.email || account.id, attempt });
          continue;
        }
        if (error.kind === 'auth') {
          upstream.invalidate(account.id);
          logger.warn('rotation.auth', { account: account.email || account.id, attempt });
          continue;
        }
      }
      break;
    }
  }
  // Pool exhausted: last-resort Vertex relay before giving up.
  if (await tryVertexFallback({ config, logger, openAiBody, res, signal, respondNative, lastError })) return;
  throw lastError ?? new UpstreamError('no accounts available', { status: 502 });
}

/** Last-resort relay to the local Vertex proxy when every antigravity account failed. */
async function tryVertexFallback({ config, logger, openAiBody, res, signal, respondNative, lastError }) {
  const fb = config.fallback;
  if (!fb?.enabled || !fb.vertexUrl || respondNative || res.headersSent) return false;
  if (!isGeminiFamily(openAiBody.model)) return false;
  logger.warn('vertex_fallback.attempt', { model: openAiBody.model, poolError: lastError?.message });
  try {
    const json = await generateViaVertexFallback({
      openAiBody, vertexUrl: fb.vertexUrl, timeoutMs: fb.timeoutMs, signal,
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
    logger.warn('vertex_fallback.ok', { model: openAiBody.model });
    return true;
  } catch (error) {
    logger.warn('vertex_fallback.failed', { model: openAiBody.model, error: error.message });
    return false;
  }
}

async function handleNonStream({ upstream, logger, account, openAiBody, res, signal, respondNative = false }) {
  const upstreamResponse = await upstream.generate({ openAiBody, account, signal });
  const json = await upstreamResponse.json();
  if (respondNative) {
    const { antigravityToGeminiNative } = await import('../rewrite/gemini-native.js');
    const nativeJson = antigravityToGeminiNative(json);
    const body = JSON.stringify(nativeJson);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    logger.info('native.completed', { model: openAiBody.model, account: account.email || account.id });
    return;
  }
  const openAiJson = antigravityToOpenAi(json, { model: openAiBody.model });
  const body = JSON.stringify(openAiJson);
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
  logger.info('chat.completed', {
    model: openAiBody.model,
    account: account.email || account.id,
    promptTokens: openAiJson.usage.prompt_tokens,
    completionTokens: openAiJson.usage.completion_tokens,
  });
}

async function handleStream({ upstream, logger, account, openAiBody, res, signal }) {
  const upstreamResponse = await upstream.generateStream({ openAiBody, account, signal });
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const indexRef = { count: 0, first: true };
  let buffer = '';

  // manual pump: stream/pipeline auto-destroys the destination on error,
  // which would swallow the error frame we want to send (H4)
  const decoder = new TextDecoder('utf8');
  let failed = null;
  try {
    for await (const chunk of upstreamResponse.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let frame;
        try { frame = JSON.parse(payload); } catch { continue; }
        const openAiChunk = antigravityChunkToOpenAiChunk(frame, { model: openAiBody.model, indexRef });
        if (openAiChunk) {
          if (!res.write(`data: ${JSON.stringify(openAiChunk)}\n\n`)) {
            await once(res, 'drain'); // backpressure
          }
        }
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    failed = error;
  }
  if (failed) {
    logger.warn('stream.aborted', { error: failed.message });
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: { message: `upstream stream failed: ${failed.message}`, type: 'server_error' } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
  logger.info('chat.streamed', { model: openAiBody.model, account: account.email || account.id });
}
