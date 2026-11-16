// Trajectory identity for the wire: the official CLI labels every generateContent with a
// cascade/trajectory/step triple and a session id derived from the conversation, so the
// backend sees an agent session instead of an anonymous script. The relay has no
// conversation object, so the conversation is inferred from the first user message and
// kept in a short-lived store: the cascade id and the session id stay stable while the
// client keeps sending the same opening turn, and the step counter advances per request.
import { createHash, randomUUID } from 'node:crypto';

const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 500;

/** FNV-1a 64 of a string as a signed decimal int64 - the CLI's sessionId shape. */
export function fnv1aInt64(text) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(String(text), 'utf8')) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  const signed = hash >= 0x8000000000000000n ? hash - 0x10000000000000000n : hash;
  return signed.toString();
}

/** Conversation key: the opening user turn plus the model, so two chats never share a cascade. */
export function conversationKey(messages, model) {
  const firstUser = (messages ?? []).find((m) => m?.role === 'user');
  const seed = typeof firstUser?.content === 'string'
    ? firstUser.content
    : JSON.stringify(firstUser?.content ?? '');
  return createHash('sha256').update(`${model}\u0000${seed}`).digest('hex').slice(0, 32);
}

export class TrajectoryStore {
  constructor({ ttlMs = TTL_MS, maxEntries = MAX_ENTRIES, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  #expire() {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.touchedAt < cutoff) this.entries.delete(key);
    }
  }

  #trim() {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
  }

  /** Cascade + session for this conversation, a fresh trajectory id and the next step. */
  begin(key) {
    this.#expire();
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { cascadeId: randomUUID(), sessionId: fnv1aInt64(key), step: 0 };
      this.entries.set(key, entry);
    }
    entry.touchedAt = this.now();
    const step = entry.step++;
    this.#trim();
    return { cascadeId: entry.cascadeId, sessionId: entry.sessionId, trajectoryId: randomUUID(), step };
  }

  get size() {
    return this.entries.size;
  }
}
