import { UpstreamError } from './upstream-client.js';

/**
 * Last-resort relay to the local Vertex OpenAI-compatible proxy (:18804) when the
 * whole antigravity account pool is exhausted. The target speaks OpenAI
 * chat/completions natively, so the request passes through almost untouched:
 * we only normalize the model id — the agy catalog's effort suffixes
 * (-low/-medium/-high) are meaningless to Vertex and would 400.
 *
 * Non-gemini models are refused here: the Vertex openapi endpoint only serves
 * google models, so a claude/qwen id would fail with a misleading upstream error.
 */
export function isGeminiFamily(model) {
  return typeof model === 'string' && model.toLowerCase().includes('gemini');
}

export function vertexModelName(model) {
  return String(model || '').replace(/-(low|medium|high)$/i, '');
}

export async function generateViaVertexFallback({ openAiBody, vertexUrl, timeoutMs = 120_000, signal, fetchImpl = globalThis.fetch }) {
  const body = { ...openAiBody, stream: false, model: vertexModelName(openAiBody.model) };
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  const resp = await fetchImpl(vertexUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.any(signals),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new UpstreamError(`vertex fallback upstream ${resp.status}: ${text.slice(0, 300)}`, { status: resp.status });
  }
  let json;
  try { json = JSON.parse(text); } catch {
    throw new UpstreamError(`vertex fallback returned non-JSON (${text.length}b)`, { status: 502 });
  }
  if (json?.error) {
    throw new UpstreamError(`vertex fallback error: ${json.error.message || 'unknown'}`, { status: 502 });
  }
  return json;
}

/**
 * Wraps a unary OpenAI-format response into the two SSE frames a streaming client
 * expects (single content chunk with finish_reason, then [DONE]). Lets a
 * stream:true request still get a valid SSE answer from the unary fallback.
 */
export function openAiJsonToStreamFrames(json, model) {
  const message = json?.choices?.[0]?.message ?? {};
  const chunk = {
    id: json?.id || `vertex-fallback-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: json?.created || Math.floor(Date.now() / 1000),
    model: json?.model || model,
    choices: [{
      index: 0,
      delta: { role: message.role || 'assistant', content: message.content || '' },
      finish_reason: json?.choices?.[0]?.finish_reason || 'stop',
    }],
    usage: json?.usage,
  };
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}
