import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountPool } from '../src/upstream/account-pool.js';
import { UpstreamClient } from '../src/upstream/upstream-client.js';
import { antigravityToOpenAi, antigravityChunkToOpenAiChunk } from '../src/rewrite/openai-translate.js';

const logger = { info() {}, warn() {}, error() {} };
const A = { id: '/home/u/.gemini/antigravity-cli/antigravity-oauth-token', email: 'a@x' };
const B = { id: '/home/u/.antigravity-proxy/accounts/acc2.json', email: null };

test('the pool stays on the first account while it is healthy', () => {
  const pool = new AccountPool({ logger });
  for (let i = 0; i < 5; i++) assert.equal(pool.pick([A, B]).id, A.id);
});

test('the second account takes over while the first is restricted, and the first gets one probe after expiry', () => {
  let now = 1_000;
  const pool = new AccountPool({ logger, now: () => now });
  pool.restrict({
    accountId: A.id, scope: 'account', until: now + 100,
    reason: 'account_restricted', evidence: 'pool_gate',
  });
  assert.equal(pool.pick([A, B]).id, B.id);
  now += 101;
  const probe = pool.select([A, B]);
  assert.equal(probe.account.id, A.id);
  assert.equal(pool.pick([A, B]).id, B.id, 'one probe at a time');
  pool.releaseProbe(probe);
});

test('a request never retries an account it already tried', () => {
  const pool = new AccountPool({ logger });
  assert.equal(pool.pick([A, B], new Set([A.id])).id, B.id);
  assert.equal(pool.pick([A, B], new Set([A.id, B.id])), null);
});

test('effective egress identity includes the authenticated session, and only its alias is exposable', () => {
  const client = new UpstreamClient({
    logger,
    config: { upstream: { egress: { url: null, accounts: {
      'a@x': 'socks5://alice:secret@127.0.0.1:1055',
      'acc2.json': 'socks5://bob:other@127.0.0.1:1055',
    } } } },
  });
  const first = client.egressIdentityFor(A);
  const second = client.egressIdentityFor(B);
  assert.equal(first.key.includes('alice'), true);
  assert.notEqual(first.key, second.key, 'same host:port, different authenticated session');
  assert.notEqual(first.alias, second.alias);
  assert.doesNotMatch(first.alias, /alice|secret|127\.0\.0\.1/);
});

test('each account resolves its own egress: by email, else by credential file name, else the default', () => {
  const client = new UpstreamClient({
    logger,
    config: { upstream: { egress: { url: 'socks5://127.0.0.1:1055', accounts: { 'a@x': 'socks5://127.0.0.1:1056', 'acc2.json': 'http://127.0.0.1:18881' } } } },
  });
  assert.equal(client.egressFor(A), 'socks5://127.0.0.1:1056');
  assert.equal(client.egressFor(B), 'http://127.0.0.1:18881');
  assert.equal(client.egressFor({ id: '/x/other.json' }), 'socks5://127.0.0.1:1055');
});

test('the oauth refresh leaves through the account egress, not the host', async () => {
  const client = new UpstreamClient({
    logger,
    config: { upstream: { eagerRefreshMs: 0, egress: { url: null, accounts: { 'acc2.json': 'socks5://127.0.0.1:1056' } } } },
  });
  const seen = [];
  client.request = async (url, opts) => {
    seen.push({ url, egressUrl: opts.egressUrl, body: opts.body });
    return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
  };
  const token = await client.accessToken({ ...B, refreshToken: 'r' });
  assert.equal(token, 'tok');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(seen[0].egressUrl, 'socks5://127.0.0.1:1056');
  assert.match(seen[0].body, /grant_type=refresh_token/);
});

test('implicit-cache hits reach the OpenAI usage (non-stream and final stream chunk)', () => {
  const usageMetadata = { promptTokenCount: 9657, candidatesTokenCount: 1, totalTokenCount: 9658, cachedContentTokenCount: 4080 };
  const out = antigravityToOpenAi({ response: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata } }, { model: 'm' });
  assert.equal(out.usage.prompt_tokens_details.cached_tokens, 4080);
  const chunk = antigravityChunkToOpenAiChunk({ response: { candidates: [{ content: {}, finishReason: 'STOP' }], usageMetadata } }, { model: 'm', indexRef: { count: 0, first: true } });
  assert.equal(chunk.usage.prompt_tokens_details.cached_tokens, 4080);
  const miss = antigravityToOpenAi({ response: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5 } } }, { model: 'm' });
  assert.equal(miss.usage.prompt_tokens_details, undefined);
});
