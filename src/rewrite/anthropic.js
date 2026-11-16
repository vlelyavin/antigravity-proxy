// Anthropic Messages API <-> the relay's internal OpenAI chat-completions shape.
//
// The relay keeps one execution path (rotation, timeouts, scoped quota/TOS state) and translates at
// the edges. The Anthropic request becomes an OpenAI chat request, the OpenAI answer becomes an
// Anthropic message. Streaming is handled by AnthropicSseResponse in server/adapters.js.

import { randomHex, stopReasonFor } from '../server/adapters.js';

function systemToText(system) {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n\n');
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function imageUrl(block) {
  const source = block?.source;
  if (!source || typeof source !== 'object') return null;
  if (source.type === 'base64' && typeof source.data === 'string') {
    return `data:${source.media_type ?? 'image/png'};base64,${source.data}`;
  }
  if (source.type === 'url' && typeof source.url === 'string') return source.url;
  return null;
}

function effortFor(thinking) {
  if (!thinking || thinking.type !== 'enabled') return null;
  const budget = Number(thinking.budget_tokens);
  if (!Number.isFinite(budget)) return 'medium';
  if (budget >= 8000) return 'high';
  if (budget >= 2000) return 'medium';
  return 'low';
}

function toolChoiceFor(choice) {
  if (!choice || typeof choice !== 'object') return undefined;
  if (choice.type === 'any') return 'required';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'tool' && typeof choice.name === 'string') {
    return { type: 'function', function: { name: choice.name } };
  }
  return 'auto';
}

/** Anthropic Messages request -> OpenAI chat-completions request. */
export function anthropicToOpenAi(body = {}) {
  const messages = [];
  const system = systemToText(body.system);
  if (system !== '') messages.push({ role: 'system', content: system });

  let pendingToolResults = [];
  const flushToolResults = () => {
    if (pendingToolResults.length > 0) {
      messages.push(...pendingToolResults);
      pendingToolResults = [];
    }
  };

  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    const role = message?.role === 'assistant' ? 'assistant' : 'user';
    const content = message?.content;
    if (typeof content === 'string') {
      flushToolResults();
      messages.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    const texts = [];
    const images = [];
    const toolCalls = [];
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        texts.push(block.text);
      } else if (block?.type === 'image') {
        const url = imageUrl(block);
        if (url) images.push({ type: 'image_url', image_url: { url } });
      } else if (block?.type === 'tool_use') {
        toolCalls.push({
          id: block.id ?? `toolu_${randomHex(24)}`,
          type: 'function',
          function: {
            name: block.name ?? 'unknown',
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      } else if (block?.type === 'tool_result') {
        // OpenAI: a tool result is its own message, before any user text from the same turn.
        pendingToolResults.push({
          role: 'tool',
          tool_call_id: block.tool_use_id ?? block.id ?? 'unknown',
          content: textOf(block.content),
        });
        for (const inner of Array.isArray(block.content) ? block.content : []) {
          if (inner?.type === 'image') {
            const url = imageUrl(inner);
            if (url) images.push({ type: 'image_url', image_url: { url } });
          }
        }
      }
    }

    if (role === 'assistant') {
      flushToolResults();
      const text = texts.join('\n');
      const assistant = { role: 'assistant', content: text === '' ? null : text };
      if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
      messages.push(assistant);
      continue;
    }

    flushToolResults();
    if (texts.length > 0) {
      messages.push({ role: 'user', content: texts.join('\n') });
    }
    if (images.length > 0) {
      messages.push({
        role: 'user',
        content: images.length === 1 ? images[0] : images,
      });
    }
  }
  flushToolResults();

  const out = {
    model: body.model,
    messages,
    stream: body.stream === true,
  };
  if (Number.isFinite(body.max_tokens)) out.max_tokens = body.max_tokens;
  if (Number.isFinite(body.temperature)) out.temperature = body.temperature;
  if (Number.isFinite(body.top_p)) out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools
      .filter((tool) => tool && typeof tool.name === 'string')
      .map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: typeof tool.description === 'string' ? tool.description : '',
          parameters: tool.input_schema ?? { type: 'object', properties: {} },
        },
      }));
  }
  const toolChoice = toolChoiceFor(body.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  const effort = effortFor(body.thinking);
  if (effort) out.reasoning_effort = effort;
  return out;
}

function parseArguments(value) {
  if (typeof value !== 'string' || value === '') return {};
  try { return JSON.parse(value); } catch { return { _raw: value }; }
}

/** OpenAI chat-completions answer -> Anthropic message. */
export function openAiToAnthropic(json, { model } = {}) {
  const choice = json?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const content = [];
  if (typeof message.content === 'string' && message.content !== '') {
    content.push({ type: 'text', text: message.content });
  }
  if (typeof message.refusal === 'string' && message.refusal !== '') {
    content.push({ type: 'text', text: message.refusal });
  }
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    content.push({
      type: 'tool_use',
      id: call.id ?? `toolu_${randomHex(24)}`,
      name: call.function?.name ?? 'unknown',
      input: parseArguments(call.function?.arguments),
    });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  const usage = json?.usage ?? {};
  return {
    id: json?.id ? `msg_${String(json.id).replace(/^chatcmpl-/, '')}` : `msg_${randomHex(24)}`,
    type: 'message',
    role: 'assistant',
    model: model ?? json?.model ?? null,
    content,
    stop_reason: stopReasonFor(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : 0,
      output_tokens: Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : 0,
    },
  };
}

/** Anthropic error envelope from a plain message/status. */
export function anthropicError(message, type = 'api_error') {
  return { type: 'error', error: { type, message } };
}

/** The relay's OpenAI error body -> the human part for the Anthropic envelope. */
export function anthropicErrorFromBody(body, fallback = 'upstream request failed') {
  try {
    const parsed = JSON.parse(body);
    const message = parsed?.error?.message ?? parsed?.message;
    if (typeof message === 'string' && message !== '') return anthropicError(message);
  } catch { /* not JSON */ }
  return anthropicError(fallback);
}
