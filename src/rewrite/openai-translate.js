// Translates OpenAI chat-completions payloads to the antigravity (Cloud Code)
// generateContent shape, and responses back. Structural transforms, no string
// splicing — same principle as claude-proxy.

import { findModel } from './models.js';

// Gemini 3.x tool-call replay requires a thoughtSignature on every functionCall
// part. Real signatures arrive in responses; clients can't roundtrip them, so
// like CLIProxyAPI we replay with the backend's own bypass marker.
export const THOUGHT_SIGNATURE_BYPASS = 'skip_thought_signature_validator';

// Google function declarations take scalar "type" strings; OpenAI-style
// unions ("type": ["string","null"]) are rejected by the upstream proto
// ("Proto field is not repeating, cannot start list"). Collapse unions to the
// first non-null type — the enum-null wire constraint from the CPA era
// (mari sessions report antigravity-verify-2026-09-21).
// keepNull: the response_format path. There the upstream ENFORCES the schema, so a
// bare collapse turns every nullable field into a required non-null one (the model
// then invents ids/dates to fill them); the null survives as `nullable: true`.
// Tool declarations keep the plain collapse — they are not enforced upstream.
function normalizeSchemaTypes(node, keepNull = false) {
  if (Array.isArray(node)) return node.map((item) => normalizeSchemaTypes(item, keepNull));
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' && Array.isArray(value)) {
      const scalar = value.find((t) => t !== 'null') ?? value[0];
      out.type = scalar;
      if (keepNull && value.includes('null')) out.nullable = true;
      continue;
    }
    if (key === 'anyOf' && Array.isArray(value)) {
      // Claude-side validation bridge (Vertex) rejects anyOf outright even though
      // draft 2020-12 allows it; oneOf passes. Union semantics for tool input
      // validation are interchangeable here, so rewrite anyOf → oneOf.
      out.oneOf = normalizeSchemaTypes(value, keepNull);
      continue;
    }
    out[key] = normalizeSchemaTypes(value, keepNull);
  }
  return out;
}

// The upstream responseSchema is an OpenAPI subset without $ref/$defs (400 "Unknown
// name $ref"), so local refs are inlined. An unresolvable or self-recursive ref
// throws: failing the request beats sending the upstream a schema it rejects anyway.
function inlineSchemaRefs(root) {
  const reject = (message) => Object.assign(new Error(`response_format: ${message}`), { status: 400 });
  const walk = (node, depth) => {
    if (Array.isArray(node)) return node.map((item) => walk(item, depth));
    if (!node || typeof node !== 'object') return node;
    if (typeof node.$ref === 'string') {
      const [, container, name] = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(node.$ref) ?? [];
      const defs = container ? root[container] : undefined;
      if (!defs || !Object.hasOwn(defs, name)) throw reject(`unresolvable $ref ${node.$ref}`);
      if (depth >= 32) throw reject(`$ref nesting too deep at ${node.$ref}`);
      // 2020-12 applies keywords next to $ref too (description, nullable unions…)
      const { $ref, ...siblings } = node;
      return walk({ ...defs[name], ...siblings }, depth + 1);
    }
    const out = {};
    for (const [key, value] of Object.entries(node)) out[key] = walk(value, depth);
    return out;
  };
  // The definition containers are root keywords; deeper down a key named
  // "definitions" is most likely a property name (data), so only the root pair goes.
  const { $defs, definitions, ...schema } = root;
  return walk(schema, 0);
}

const STOP_MAP = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
  BLOCKLIST: 'content_filter',
  PROHIBITED_CONTENT: 'content_filter',
  SPII: 'content_filter',
  OTHER: 'content_filter',
};

function partsFromContent(content) {
  if (typeof content === 'string') {
    return content === '' ? [] : [{ text: content }];
  }
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (typeof item === 'string') {
        parts.push({ text: item });
      } else if (item?.type === 'text' && typeof item.text === 'string') {
        parts.push({ text: item.text });
      } else if (item?.type === 'image_url' && item.image_url?.url) {
        // data URLs only — http(s) image URLs would require a fetch the relay does not do
        const url = item.image_url.url;
        const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
        if (match) {
          parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
        } else if (/^https?:/i.test(url)) {
          const error = new Error('only data: URLs are supported for image_url (relay does not fetch remote media)');
          error.status = 400;
          throw error;
        }
        // other schemes: ignore silently (unchanged behavior)
      } else if (item?.type === 'file_uri' && item.fileUri) {
        // native Gemini fileData passthrough (from gemini-native.js)
        const fd = { fileUri: item.fileUri };
        if (item.mimeType) fd.mimeType = item.mimeType;
        const part = { fileData: fd };
        if (item.videoMetadata) part.videoMetadata = item.videoMetadata;
        parts.push(part);
      }
    }
    return parts;
  }
  return [];
}

const EFFORT_BUDGET = { low: 1000, medium: 4000, high: -1 };

export function openAiToAntigravity({ model, messages, max_tokens, max_completion_tokens, temperature, top_p, stop, tools, tool_choice, reasoning_effort, response_format }, { projectId, sessionId }) {
  const catalogEntry = findModel(model);
  const budget = Number.isFinite(max_tokens) ? max_tokens : max_completion_tokens;
  const contents = [];
  let systemText = [];

  for (const message of messages) {
    const role = message.role;
    if (role === 'system' || role === 'developer') {
      const systemParts = partsFromContent(message.content);
      systemText.push(...systemParts.map((p) => p.text).filter((t) => typeof t === 'string'));
      continue;
    }
    if (role === 'tool') {
      // tool result feeds back as a functionResponse part
      // The antigravity->Claude bridge requires an id on tool_result; pass the
      // OpenAI tool_call_id through so the functionCall/functionResponse pair links.
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: message.name || message.tool_call_id || 'tool',
            ...(message.tool_call_id ? { id: message.tool_call_id } : {}),
            response: { result: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) },
          },
        }],
      });
      continue;
    }

    const parts = [];
    const contentParts = partsFromContent(message.content);
    parts.push(...contentParts);
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        let args = {};
        try { args = JSON.parse(call.function?.arguments || '{}'); } catch { /* keep {} */ }
        const fc = { name: call.function?.name, args };
        if (call.id) fc.id = call.id;
        parts.push({
          functionCall: fc,
          thoughtSignature: call.thought_signature || THOUGHT_SIGNATURE_BYPASS,
        });
      }
    }
    if (parts.length === 0 && role === 'assistant') {
      // empty assistant bubbles (e.g. tool-call-only turns) still need a marker part
      parts.push({ text: '' });
    }
    contents.push({ role: role === 'assistant' ? 'model' : 'user', parts });
  }

  const generationConfig = {};
  if (catalogEntry) {
    // wire defaults captured from the official CLI (see models.js)
    generationConfig.maxOutputTokens = Number.isFinite(budget)
      ? budget
      : catalogEntry.maxOutputTokens;
    // reasoning_effort overrides the model-suffix budget (CPA parity: the Mari
    // lane pins effort=low on a -high model and expects ~0 reasoning tokens)
    const effortBudget = reasoning_effort in EFFORT_BUDGET ? EFFORT_BUDGET[reasoning_effort] : null;
    const thinkingBudget = effortBudget ?? catalogEntry.budget;
    generationConfig.thinkingConfig = {
      includeThoughts: thinkingBudget !== 0,
      thinkingBudget,
    };
  } else {
    if (Number.isFinite(budget)) generationConfig.maxOutputTokens = budget;
  }
  if (Number.isFinite(temperature)) generationConfig.temperature = temperature;
  if (Number.isFinite(top_p)) generationConfig.topP = top_p;
  if (stop) generationConfig.stopSequences = Array.isArray(stop) ? stop : [stop];
  // OpenAI structured outputs -> Gemini generateConfig. Previously dropped silently:
  // every strict-schema caller (session ledger, memory integrator, collectors) ran
  // unconstrained through this relay and malformed JSON surfaced downstream as
  // parse failures. json_schema -> responseMimeType + responseSchema; json_object
  // -> responseMimeType only. Local $refs are inlined and type unions keep their
  // null as `nullable` (the upstream enforces this schema; see normalizeSchemaTypes).
  if (response_format && typeof response_format === 'object') {
    const fmt = response_format.type;
    if (fmt === 'json_schema' && response_format.json_schema?.schema && typeof response_format.json_schema.schema === 'object') {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseSchema = normalizeSchemaTypes(inlineSchemaRefs(response_format.json_schema.schema), true);
    } else if (fmt === 'json_object' || fmt === 'json') {
      generationConfig.responseMimeType = 'application/json';
    }
  }

  const request = {
    contents,
    generationConfig,
    sessionId,
  };
  if (systemText.length > 0) {
    request.systemInstruction = { parts: [{ text: systemText.join('\n\n') }] };
  }

  if (Array.isArray(tools) && tools.length > 0) {
    const fns = [];
    for (const tool of tools) {
      if (tool?.type === 'function' && tool.function?.name) {
        fns.push({
          name: tool.function.name,
          description: tool.function.description || '',
          parameters: normalizeSchemaTypes(tool.function.parameters || { type: 'object', properties: {} }),
        });
      }
    }
    if (fns.length > 0) request.tools = [{ functionDeclarations: fns }];
  }

  return {
    model: catalogEntry ? (catalogEntry.upstreamModel ?? catalogEntry.id) : model,
    userAgent: 'antigravity',
    requestType: 'agent',
    project: projectId,
    requestId: `agent-${crypto.randomUUID()}`,
    request,
  };
}

import crypto from 'node:crypto';

/** antigravity response -> OpenAI chat-completions response body */
export function antigravityToOpenAi(respJson, { model, stream = false }) {
  const wrapper = respJson?.response ?? respJson;
  const candidate = wrapper?.candidates?.[0] ?? {};
  const parts = candidate?.content?.parts ?? [];
  let text = '';
  let reasoning = '';
  const toolCalls = [];
  let usageIn = null, usageOut = null, usageThink = null;

  for (const part of parts) {
    if (typeof part.text === 'string') {
      if (part.thought === true) reasoning += part.text; // thinking -> reasoning_content
      else text += part.text;
    }
    if (part.functionCall?.name) {
      toolCalls.push({
        id: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'function',
        function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) },
        ...(part.thoughtSignature ? { thought_signature: part.thoughtSignature } : {}),
      });
    }
  }
  const usage = wrapper?.usageMetadata ?? {};
  usageIn = usage.promptTokenCount ?? null;
  usageOut = usage.candidatesTokenCount ?? usage.totalTokenCount ?? null;
  usageThink = usage.thoughtsTokenCount ?? null;

  const message = { role: 'assistant', content: text === '' ? null : text };
  if (reasoning !== '') message.reasoning_content = reasoning;
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
    if (message.content === null && toolCalls.length > 0) message.content = null;
  }
  return {
    id: `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: STOP_MAP[candidate?.finishReason] ?? 'stop',
    }],
    usage: {
      prompt_tokens: usageIn ?? 0,
      completion_tokens: (usageOut ?? 0) + (usageThink ?? 0),
      total_tokens: (usageIn ?? 0) + (usageOut ?? 0) + (usageThink ?? 0),
    },
  };
}

/** One SSE data frame (antigravity stream chunk) -> OpenAI stream chunk, or null when nothing to emit. */
export function antigravityChunkToOpenAiChunk(frameJson, { model, indexRef }) {
  const wrapper = frameJson?.response ?? frameJson;
  const candidate = wrapper?.candidates?.[0] ?? {};
  const parts = candidate?.content?.parts ?? [];
  let text = '';
  let reasoning = '';
  const toolCalls = [];
  for (const part of parts) {
    if (typeof part.text === 'string') {
      if (part.thought === true) reasoning += part.text; // thinking -> reasoning_content
      else text += part.text;
    }
    if (part.functionCall?.name) {
      toolCalls.push({
        index: indexRef.count++,
        id: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'function',
        function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) },
        ...(part.thoughtSignature ? { thought_signature: part.thoughtSignature } : {}),
      });
    }
  }
  if (text === '' && reasoning === '' && toolCalls.length === 0 && !candidate.finishReason) return null;

  const delta = {};
  if (indexRef.first) {
    delta.role = 'assistant';
    indexRef.first = false;
  }
  if (text !== '') delta.content = text;
  if (reasoning !== '') delta.reasoning_content = reasoning;
  if (toolCalls.length > 0) delta.tool_calls = toolCalls;

  const chunk = {
    id: `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: candidate.finishReason ? (STOP_MAP[candidate.finishReason] ?? 'stop') : null }],
  };
  const usage = wrapper?.usageMetadata;
  if (candidate.finishReason && usage) {
    chunk.usage = {
      prompt_tokens: usage.promptTokenCount ?? 0,
      completion_tokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
      total_tokens: usage.totalTokenCount ?? 0,
    };
  }
  return chunk;
}

/** Strip vendor prefixes some clients prepend (openrouter-style "google/…"). */
export function canonicalModel(model) {
  if (typeof model !== 'string') return model;
  const slash = model.indexOf('/');
  if (slash !== -1 && ['google', 'antigravity', 'gemini', 'models'].includes(model.slice(0, slash))) {
    return model.slice(slash + 1);
  }
  // "models/gemini-..." (vertex-style) — keep the bare id
  if (model.startsWith('models/')) return model.slice('models/'.length);
  return model;
}
