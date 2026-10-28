// F3 (audit 2026-10-28, owner rule: rotation never changes provider or downgrades reasoning):
// the shipped Vertex fallback must be OFF by default, and only an explicit instruction may turn it on.
//
// The audited defect: DEFAULTS.fallback.enabled was true and no tracked production config carries a
// `fallback` key, so on pool exhaustion the relay silently answered from a different provider and
// rewrote gemini-3.8-flash-high -> gemini-3.8-flash (audit scenario S17).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/load-config.js';
import { DEFAULTS } from '../src/config/defaults.js';

const ENV_ONLY = { ANTIGRAVITY_PROXY_PORT: '0', ANTIGRAVITY_PROXY_LOG_LEVEL: 'error' };

/** loadConfig reads config.json from cwd; run in an empty temp dir so only DEFAULTS+env apply. */
function loadWith(t, { file = null, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-fallback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (file) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(file));
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return loadConfig({ env: { ...ENV_ONLY, ...env } });
  } finally {
    process.chdir(previous);
  }
}

test('the shipped default keeps the Vertex fallback disabled', (t) => {
  assert.equal(DEFAULTS.fallback.enabled, false, 'the default constant itself is off');
  const config = loadWith(t);
  assert.equal(config.fallback.enabled, false, 'a config with no fallback key gets the disabled default');
  // the target stays configured, so an explicit `enabled: true` needs only a switch
  assert.equal(config.fallback.vertexUrl, DEFAULTS.fallback.vertexUrl);
});

test('a production-shaped config (no fallback key at all) never falls back', (t) => {
  // the exact key shape of every tracked config.json.bak-*: listen, apiKey, upstream.egress
  const config = loadWith(t, {
    file: {
      listen: { host: '127.0.0.1', port: 8317 },
      apiKey: 'none',
      upstream: { egress: { url: 'socks5://127.0.0.1:1055', accounts: { 'a@example.test': 'http://127.0.0.1:21143' } } },
    },
  });
  assert.equal(config.fallback.enabled, false, 'no fallback key means no fallback, not the old shipped default');
});

test('enabling stays possible, but only explicitly', (t) => {
  assert.equal(loadWith(t, { file: { fallback: { enabled: true } } }).fallback.enabled, true,
    'config.json can still turn it on');
  assert.equal(loadWith(t, { file: { fallback: { enabled: false } } }).fallback.enabled, false);

  // env: a url is an explicit instruction and enables the relay it names
  const viaUrl = loadWith(t, { env: { ANTIGRAVITY_PROXY_VERTEX_FALLBACK: 'http://127.0.0.1:18804/v1/chat/completions' } });
  assert.equal(viaUrl.fallback.enabled, true);
  assert.equal(viaUrl.fallback.vertexUrl, 'http://127.0.0.1:18804/v1/chat/completions');
  // ...and a bare switch enables the configured url
  assert.equal(loadWith(t, { env: { ANTIGRAVITY_PROXY_VERTEX_FALLBACK: 'on' } }).fallback.enabled, true);
  assert.equal(loadWith(t, { env: { ANTIGRAVITY_PROXY_VERTEX_FALLBACK: 'true' } }).fallback.enabled, true);
  assert.equal(loadWith(t, { env: { ANTIGRAVITY_PROXY_VERTEX_FALLBACK: '1' } }).fallback.enabled, true);
  // the documented off values keep it off, even over a config that enabled it
  assert.equal(loadWith(t, {
    file: { fallback: { enabled: true } },
    env: { ANTIGRAVITY_PROXY_VERTEX_FALLBACK: 'off' },
  }).fallback.enabled, false);
  assert.equal(loadWith(t, {
    file: { fallback: { enabled: true } },
    env: { ANTIGRAVITY_PROXY_VERTEX_FALLBACK: 'none' },
  }).fallback.enabled, false);
  // nothing in the environment leaves it accidentally on
  assert.equal(loadWith(t, { env: { ANTIGRAVITY_PROXY_VERTEX_FALLBACK: '' } }).fallback.enabled, false);
});
