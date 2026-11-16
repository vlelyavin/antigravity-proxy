// Response adapters: let the existing rotation/streaming machinery feed an alternate wire format.
//
// `handleWithRotation` writes one of three things into `res`: a JSON body (non-stream), OpenAI SSE
// frames (stream), or an error body with an HTTP status. A BufferResponse collects the first and
// third; an SseAdapter turns the OpenAI frames into another protocol's SSE events on the fly, so
// the caller keeps live streaming instead of waiting for the whole answer.

import { StringDecoder } from 'node:string_decoder';

class AdapterBase {
  constructor() {
    this.status = 200;
    this.headers = {};
    this.headersSent = false;
    this.writableEnded = false;
    this.destroyed = false;
    this.finished = false;
    this.listeners = new Map();
  }

  setHeader(name, value) {
    this.headers[name] = value;
  }

  once(event, callback) {
    const list = this.listeners.get(event) ?? [];
    const wrapped = (...args) => {
      this.listeners.set(event, (this.listeners.get(event) ?? []).filter((fn) => fn !== wrapped));
      callback(...args);
    };
    list.push(wrapped);
    this.listeners.set(event, list);
    return this;
  }

  on(event, callback) {
    const list = this.listeners.get(event) ?? [];
    list.push(callback);
    this.listeners.set(event, list);
    return this;
  }

  emit(event, ...args) {
    for (const callback of [...(this.listeners.get(event) ?? [])]) callback(...args);
    return true;
  }

  destroy() {
    this.destroyed = true;
    this.emit('close');
  }
}

/** Collects a JSON body (and status) produced by the normal handler path. */
export class BufferResponse extends AdapterBase {
  constructor() {
    super();
    this.chunks = [];
    this.decoder = new StringDecoder('utf8');
  }

  writeHead(status, headers = {}) {
    this.status = status;
    Object.assign(this.headers, headers);
    this.headersSent = true;
    return this;
  }

  write(chunk) {
    if (this.writableEnded) return true;
    this.chunks.push(typeof chunk === 'string' ? chunk : this.decoder.write(chunk));
    return true;
  }

  end(chunk) {
    if (chunk !== undefined && chunk !== null) this.write(chunk);
    this.chunks.push(this.decoder.end());
    this.writableEnded = true;
    this.finished = true;
    return this;
  }

  get body() {
    return this.chunks.join('');
  }
}

/**
 * Base SSE adapter: parses the handler's OpenAI SSE frames (`data: {...}` lines) and delegates each
 * chunk to onDelta(). Subclasses emit their own protocol's events through send().
 */
export class SseAdapter extends AdapterBase {
  constructor(realRes, { model = null } = {}) {
    super();
    this.res = realRes;
    this.model = model;
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.started = false;
    this.done = false;
  }

  writeHead(status, headers = {}) {
    this.status = status;
    this.headersSent = true;
    if (status >= 200 && status < 300) this.start();
    else Object.assign(this.headers, headers);
    return this;
  }

  start() {
    if (this.started || this.res.writableEnded) return;
    this.started = true;
    this.res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    this.onStart();
  }

  write(chunk) {
    if (this.writableEnded) return true;
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    this.drain(false);
    return true;
  }

  end(chunk) {
    if (chunk !== undefined && chunk !== null) this.write(chunk);
    this.buffer += this.decoder.end();
    this.drain(true);
    if (this.status >= 200 && this.status < 300) {
      if (!this.started) this.start();
      this.onDone();
      if (!this.res.writableEnded) this.res.end();
    } else {
      // The lane still owns the socket: it answers with the protocol's HTTP error envelope.
      this.onHttpError();
    }
    this.writableEnded = true;
    this.finished = true;
    return this;
  }

  drain(final) {
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.line(line);
    }
    if (final && this.buffer.trim() !== '') {
      this.line(this.buffer);
      this.buffer = '';
    }
  }

  line(line) {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trimStart();
    if (payload === '' || payload === '[DONE]') return;
    let parsed;
    try { parsed = JSON.parse(payload); } catch { return; }
    if (parsed?.error) {
      this.onUpstreamError(typeof parsed.error === 'string' ? parsed.error : (parsed.error.message ?? 'upstream error'));
      return;
    }
    this.onDelta(parsed);
  }

  send(event, data) {
    if (this.res.writableEnded || this.res.destroyed) return;
    if (!this.started) this.start();
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // subclass hooks
  onStart() {}
  onDelta() {}
  onDone() {}
  onUpstreamError(message) { this.onError(message); }
  onError() {}
  onHttpError() {}
}

/** Anthropic Messages SSE: the event sequence Claude clients expect. */
export class AnthropicSseResponse extends SseAdapter {
  constructor(realRes, { model = null, messageId = null } = {}) {
    super(realRes, { model });
    this.messageId = messageId ?? `msg_${randomHex(24)}`;
    this.blockIndex = -1;
    this.textIndex = -1;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.stopReason = null;
    this.messageStarted = false;
    this.errorBody = null;
  }

  onStart() {
    this.messageStart();
  }

  messageStart() {
    if (this.messageStarted) return;
    this.messageStarted = true;
    this.send('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.inputTokens, output_tokens: 0 },
      },
    });
  }

  onDelta(chunk) {
    const choice = chunk.choices?.[0];
    if (!choice) {
      if (chunk.usage) this.captureUsage(chunk.usage);
      return;
    }
    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string' && delta.content !== '') this.text(delta.content);
    for (const call of delta.tool_calls ?? []) this.toolUse(call);
    if (choice.finish_reason) this.stopReason = stopReasonFor(choice.finish_reason);
    if (chunk.usage) this.captureUsage(chunk.usage);
  }

  captureUsage(usage) {
    if (Number.isFinite(usage.prompt_tokens)) this.inputTokens = usage.prompt_tokens;
    if (Number.isFinite(usage.completion_tokens)) this.outputTokens = usage.completion_tokens;
  }

  text(value) {
    if (this.textIndex === -1) {
      this.textIndex = ++this.blockIndex;
      this.send('content_block_start', {
        type: 'content_block_start',
        index: this.textIndex,
        content_block: { type: 'text', text: '' },
      });
    }
    this.send('content_block_delta', {
      type: 'content_block_delta',
      index: this.textIndex,
      delta: { type: 'text_delta', text: value },
    });
  }

  closeText() {
    if (this.textIndex === -1) return;
    this.send('content_block_stop', { type: 'content_block_stop', index: this.textIndex });
    this.textIndex = -1;
  }

  toolUse(call) {
    this.closeText();
    const index = ++this.blockIndex;
    const id = call.id ?? `toolu_${randomHex(24)}`;
    this.send('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id, name: call.function?.name ?? 'unknown', input: {} },
    });
    const args = call.function?.arguments;
    if (typeof args === 'string' && args !== '') {
      this.send('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: args },
      });
    }
    this.send('content_block_stop', { type: 'content_block_stop', index });
  }

  onDone() {
    // A stream that already emitted `error` must not be closed with a clean message_stop.
    if (this.errorBody) return;
    this.messageStart();
    this.closeText();
    this.send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: this.stopReason ?? 'end_turn', stop_sequence: null },
      usage: { output_tokens: this.outputTokens },
    });
    this.send('message_stop', { type: 'message_stop' });
  }

  onUpstreamError(message) {
    this.errorBody = message;
    this.send('error', {
      type: 'error',
      error: { type: 'api_error', message },
    });
  }

  onHttpError() {}
  onError(message) { this.onUpstreamError(message); }
}

/** OpenAI Responses SSE: the event set Codex and the Responses clients consume. */
export class ResponsesSseResponse extends SseAdapter {
  constructor(realRes, { model = null, responseId = null } = {}) {
    super(realRes, { model });
    this.responseId = responseId ?? `resp_${randomHex(24)}`;
    this.itemId = `msg_${randomHex(24)}`;
    this.outputIndex = 0;
    this.text = '';
    this.toolCalls = [];
    this.createdSent = false;
    this.messageStarted = false;
    this.usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    this.status = 'completed';
    this.errorMessage = null;
  }

  startedEvent() {
    return {
      id: this.responseId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'in_progress',
      model: this.model,
      output: [],
    };
  }

  onStart() {
    if (this.createdSent) return;
    this.createdSent = true;
    this.send('response.created', { type: 'response.created', response: this.startedEvent() });
  }

  onDelta(chunk) {
    const choice = chunk.choices?.[0];
    if (!choice) {
      if (chunk.usage) this.captureUsage(chunk.usage);
      return;
    }
    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string' && delta.content !== '') this.textDelta(delta.content);
    for (const call of delta.tool_calls ?? []) this.toolDelta(call);
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    if (chunk.usage) this.captureUsage(chunk.usage);
  }

  captureUsage(usage) {
    if (Number.isFinite(usage.prompt_tokens)) this.usage.input_tokens = usage.prompt_tokens;
    if (Number.isFinite(usage.completion_tokens)) this.usage.output_tokens = usage.completion_tokens;
    if (Number.isFinite(usage.total_tokens)) this.usage.total_tokens = usage.total_tokens;
    else this.usage.total_tokens = this.usage.input_tokens + this.usage.output_tokens;
  }

  messageStart() {
    if (this.messageStarted) return;
    this.messageStarted = true;
    this.send('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: this.outputIndex,
      item: { id: this.itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
    });
    this.send('response.content_part.added', {
      type: 'response.content_part.added',
      item_id: this.itemId,
      output_index: this.outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  }

  textDelta(value) {
    this.messageStart();
    this.text += value;
    this.send('response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: this.itemId,
      output_index: this.outputIndex,
      content_index: 0,
      delta: value,
    });
  }

  toolDelta(call) {
    const id = call.id ?? `call_${randomHex(24)}`;
    const item = {
      type: 'function_call',
      id: `fc_${randomHex(24)}`,
      call_id: id,
      name: call.function?.name ?? 'unknown',
      arguments: call.function?.arguments ?? '{}',
      status: 'completed',
    };
    this.toolCalls.push(item);
    const index = this.messageStarted ? this.outputIndex + 1 : this.outputIndex;
    this.send('response.output_item.added', {
      type: 'response.output_item.added', output_index: index, item: { ...item, status: 'in_progress' },
    });
    this.send('response.output_item.done', { type: 'response.output_item.done', output_index: index, item });
  }

  messageItem() {
    return {
      id: this.itemId,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{
        type: 'output_text',
        text: this.text,
        annotations: [],
      }],
    };
  }

  onDone() {
    if (this.errorMessage) return;
    if (this.text !== '' || this.toolCalls.length === 0) this.messageStart();
    if (this.text !== '') {
      this.send('response.output_text.done', {
        type: 'response.output_text.done',
        item_id: this.itemId,
        output_index: 0,
        content_index: 0,
        text: this.text,
      });
    }
    this.send('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: this.messageItem(),
    });
    this.send('response.completed', {
      type: 'response.completed',
      response: {
        id: this.responseId,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status: this.status,
        model: this.model,
        output: [this.messageItem(), ...this.toolCalls],
        usage: this.usage,
      },
    });
  }

  onUpstreamError(message) {
    this.errorMessage = message;
    this.status = 'failed';
    this.send('response.failed', {
      type: 'response.failed',
      response: {
        id: this.responseId,
        object: 'response',
        status: 'failed',
        model: this.model,
        error: { code: 'server_error', message },
      },
    });
  }

  onError(message) { this.onUpstreamError(message); }
  onHttpError() {}
}

export function stopReasonFor(finishReason) {
  switch (finishReason) {
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    case 'content_filter': return 'end_turn';
    default: return 'end_turn';
  }
}

export function randomHex(bytes) {
  return Array.from({ length: bytes }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
}
