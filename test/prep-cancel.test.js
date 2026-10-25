// Preparation cancellation, for real: the caller's signal reaches the project probe (its request and
// its body read), a caller that has left starts no probe, and the shared token refresh - which is
// never cancelled by one caller - is bounded by the transport timeout instead. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/load-config.js';
import { UpstreamClient, UpstreamError , generationOf} from '../src/upstream/upstream-client.js';

const CONFIG = loadConfig({ env: { ANTIGRAVITY_PROXY_PORT: '0', ANTIGRAVITY_PROXY_LOG_LEVEL: 'error' } });
const BODY = { model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'synthetic' }] };

function recorder() {
  const events = [];
  const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((level) => [
    level, (event, data = {}) => events.push({ level, event, ...data }),
  ]));
  return { logger, events };
}

test('the project probe is cancelled with the caller that started it', { timeout: 2000 }, async () => {
  const { logger } = recorder();
  const client = new UpstreamClient({ currentGeneration: generationOf, config: CONFIG, logger });
  client.accessToken = async () => 'synthetic-token';
  const probes = [];
  let markProbeStarted;
  const probeStarted = new Promise((resolve) => { markProbeStarted = resolve; });
  // like the real transport: the request settles only on a response or on an abort
  client.request = async (url, { signal } = {}) => {
    probes.push({ url, hasSignal: Boolean(signal) });
    markProbeStarted();
    return new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const leaving = new AbortController();
  const reason = new Error('client disconnected');
  const pending = client.generate({ openAiBody: BODY, account: { generation: 'synthetic', id: 'probe-account', refreshToken: 'r' }, signal: leaving.signal });
  await probeStarted;
  assert.equal(probes.length, 1);
  assert.match(probes[0].url, /loadCodeAssist/);
  assert.equal(probes[0].hasSignal, true, 'the probe request is owned by the caller');
  leaving.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(probes.length, 1);
});

test('an already cancelled caller starts no project probe', { timeout: 2000 }, async () => {
  const { logger } = recorder();
  const client = new UpstreamClient({ currentGeneration: generationOf, config: CONFIG, logger });
  let probes = 0;
  client.accessToken = async () => 'synthetic-token';
  client.request = async () => { probes += 1; return { ok: true, json: async () => ({ cloudaicompanionProject: 'p' }) }; };
  const leaving = new AbortController();
  const reason = new Error('client disconnected');
  leaving.abort(reason);
  await assert.rejects(client.ensureProject({ generation: 'synthetic', id: 'probe-account' }, { signal: leaving.signal }), (error) => error === reason);
  assert.equal(probes, 0);
});

test('a caller that leaves while the shared refresh runs starts no probe afterwards', { timeout: 2000 }, async () => {
  const { logger } = recorder();
  const client = new UpstreamClient({ currentGeneration: generationOf, config: CONFIG, logger });
  let probes = 0;
  let markRefreshStarted;
  const refreshStarted = new Promise((resolve) => { markRefreshStarted = resolve; });
  // a shared refresh that outlives its caller by a wide margin
  client.accessToken = () => {
    markRefreshStarted();
    return new Promise((resolve) => setTimeout(() => resolve('shared-token'), 80));
  };
  client.request = async () => { probes += 1; return { ok: true, json: async () => ({ cloudaicompanionProject: 'p' }) }; };
  const leaving = new AbortController();
  const reason = new Error('client disconnected');
  const pending = client.ensureProject({ generation: 'synthetic', id: 'probe-account' }, { signal: leaving.signal });
  await refreshStarted;
  setTimeout(() => leaving.abort(reason), 10);
  await assert.rejects(pending, (error) => error === reason);
  await new Promise((resolve) => setTimeout(resolve, 150)); // the refresh has finished by now
  assert.equal(probes, 0, 'the probe must not start for a caller that already left');
});

test('the project id is cached: one probe, then the in-memory value', { timeout: 2000 }, async () => {
  const { logger } = recorder();
  const client = new UpstreamClient({ currentGeneration: generationOf, config: CONFIG, logger });
  client.accessToken = async () => 'synthetic-token';
  let probes = 0;
  client.request = async () => {
    probes += 1;
    return { ok: true, json: async () => ({ cloudaicompanionProject: 'project-from-probe' }) };
  };
  const account = { generation: 'synthetic', id: 'cache-account' };
  assert.equal(await client.ensureProject(account), 'project-from-probe');
  assert.equal(await client.ensureProject({ generation: 'synthetic', id: 'cache-account' }), 'project-from-probe');
  assert.equal(probes, 1);
  // a credential file that already carries the project never probes at all
  assert.equal(await client.ensureProject({ generation: 'synthetic', id: 'other', projectId: 'from-file' }), 'from-file');
  assert.equal(probes, 1);
});

test('a hung token endpoint is bounded by the transport timeout and does not pin the dedup entry', { timeout: 2000 }, async (t) => {
  // AbortSignal.timeout is unref'ed. This socket-free mock must own an event-loop reference,
  // like the real pending network request, until the transport timeout or test deadline settles.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const { logger } = recorder();
  const config = { ...CONFIG, upstream: { ...CONFIG.upstream, requestTimeoutMs: 60, eagerRefreshMs: 0, egress: { url: null } } };
  const client = new UpstreamClient({ currentGeneration: generationOf, config, logger });
  const seen = [];
  const fetchImpl = (url, options = {}) => new Promise((resolve, reject) => {
    seen.push({ url, hasSignal: Boolean(options.signal) });
    options.signal?.addEventListener('abort', () => reject(new Error('transport aborted')), { once: true });
  });
  const startedAt = Date.now();
  await assert.rejects(
    client.accessToken({ generation: 'synthetic', id: 'hung-refresh', refreshToken: 'r' }, { fetchImpl }),
    (error) => error instanceof UpstreamError
      && error.reason === 'oauth_unavailable'
      && error.publicStatus === 502
      && error.kind !== 'auth',
  );
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 1000, `the refresh must be bounded by requestTimeoutMs: ${elapsedMs}ms`);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].hasSignal, true, 'the refresh network carries a timeout signal');
  assert.equal(client.refreshing.size, 0, 'a failed refresh leaves no in-flight entry behind');
});
