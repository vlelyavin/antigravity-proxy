// OpenAI Responses API <-> the relay's internal OpenAI chat-completions shape.
//
// Non-stream answers are converted into a `response` object; streaming is handled by
// ResponsesSseResponse in server/adapters.js.

import { randomHex } from '../server/adapters.js';

function textOf(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .filter((part) => part && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n');
  }
  if (output && typeof output === 'object' && typeof output.content === 'string') return output.content;
  return '';
}

function toolChoiceFor(choice) {
  if (choice === undefined || choice === null) return undefined;
  if (typeof choice === 'string') return choice;
  if (typeof choice === 'object' && typeof choice.name === 'string') {
    return { type: 'function', function: { name: choice.name } };
  }
  return undefined;
}

/** Responses request -> OpenAI chat-completions request. */
export function responsesToOpenAi(body = {}) {
  const messages = [];
  if (typeof body.instructions === 'string' && body.instructions !== '') {
    messages.push({ role: 'system', content: body.instructions });
  }
  const input = body.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item });
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      if (item.type === 'function_call_output') {
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id ?? item.id ?? 'unknown',
          content: textOf(item.output),
        });
        continue;
      }
      if (item.type === 'function_call') {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: item.call_id ?? item.id ?? `call_${randomHex(24)}`,
            type: 'function',
            function: { name: item.name ?? 'unknown', arguments: item.arguments ?? '{}' },
          }],
        });
        continue;
      }
      const role = item.role === 'assistant' ? 'assistant'
        : (item.role === 'system' || item.role === 'developer' ? 'system' : 'user');
      const content = item.content;
      if (typeof content === 'string') {
        messages.push({ role, content });
        continue;
      }
      if (!Array.isArray(content)) continue;
      const texts = [];
      const images = [];
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
          if (typeof part.text === 'string') texts.push(part.text);
        } else if (part.type === 'input_image') {
          const url = part.image_url ?? part.url;
          if (typeof url === 'string') images.push({ type: 'image_url', image_url: { url } });
        }
      }
      if (texts.length > 0) messages.push({ role, content: texts.join('\n') });
      if (images.length > 0) {
        messages.push({ role, content: images.length === 1 ? images[0] : images });
      }
    }
  }

  const out = {
    model: body.model,
    messages,
    stream: body.stream === true,
  };
  if (Number.isFinite(body.max_output_tokens)) out.max_tokens = body.max_output_tokens;
  if (Number.isFinite(body.temperature)) out.temperature = body.temperature;
  if (Number.isFinite(body.top_p)) out.top_p = body.top_p;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools
      .filter((tool) => tool && tool.type === 'function' && typeof tool.name === 'string')
      .map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: typeof tool.description === 'string' ? tool.description : '',
          parameters: tool.parameters ?? { type: 'object', properties: {} },
        },
      }));
  }
  const toolChoice = toolChoiceFor(body.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  if (body.reasoning && typeof body.reasoning.effort === 'string') {
    out.reasoning_effort = body.reasoning.effort;
  }
  return out;
}

/** OpenAI chat-completions answer -> Responses object. */
export function openAiToResponses(json, { model } = {}) {
  const choice = json?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const text = typeof message.content === 'string' ? message.content : '';
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const output = [];
  if (text !== '' || toolCalls.length === 0) {
    output.push({
      id: `msg_${randomHex(24)}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }
  for (const call of toolCalls) {
    output.push({
      type: 'function_call',
      id: `fc_${randomHex(24)}`,
      call_id: call.id ?? `call_${randomHex(24)}`,
      name: call.function?.name ?? 'unknown',
      arguments: call.function?.arguments ?? '{}',
      status: 'completed',
    });
  }
  const usage = json?.usage ?? {};
  const inputTokens = Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : 0;
  const outputTokens = Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : 0;
  return {
    id: json?.id ? `resp_${String(json.id).replace(/^chatcmpl-/, '')}` : `resp_${randomHex(24)}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: model ?? json?.model ?? null,
    output,
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: Number.isFinite(usage.total_tokens) ? usage.total_tokens : inputTokens + outputTokens,
    },
  };
}

export function responsesError(message, code = 'server_error') {
  return { error: { message, type: 'api_error', code } };
}
