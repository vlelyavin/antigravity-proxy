import test from 'node:test';
import assert from 'node:assert/strict';
import { CredentialStore, normalizeAccount } from '../src/credentials/credential-store.js';
import { loadConfig } from '../src/config/load-config.js';
import { AccountPool } from '../src/upstream/account-pool.js';

test('normalizes the agy token file shape', () => {
  const account = normalizeAccount({
    auth_method: 'consumer',
    email: 'x@gmail.com',
    token: { access_token: 'A', refresh_token: 'R', expiry: '2026-09-21T13:00:00Z' },
  }, '/tmp/f');
  assert.equal(account.email, 'x@gmail.com');
  assert.equal(account.accessToken, 'A');
  assert.equal(account.refreshToken, 'R');
  assert.ok(account.expiry > 0);
});

test('normalizes the gemini-cli token file shape with id_token email', () => {
  const idToken = 'h.' + Buffer.from(JSON.stringify({ email: 'y@gmail.com' })).toString('base64url') + '.s';
  const account = normalizeAccount({ access_token: 'A', refresh_token: 'R', expiry_date: 1758459600000, id_token: idToken }, '/tmp/f');
  assert.equal(account.email, 'y@gmail.com');
});

test('readAll throws a helpful error when nothing found', () => {
  const store = new CredentialStore({ searchPaths: ['/nonexistent/path/x.json'], logger: console });
  assert.throws(() => store.readAll(), /no antigravity token files found/);
});

test('config defaults + env override', () => {
  const config = loadConfig({ env: { ANTIGRAVITY_PROXY_PORT: '9999', ANTIGRAVITY_PROXY_API_KEY: 'sk-test' } });
  assert.equal(config.listen.port, 9999);
  assert.equal(config.apiKey, 'sk-test');
  assert.equal(config.upstream.baseUrl, 'https://daily-cloudcode-pa.googleapis.com');
});

test('config file overrides defaults', async () => {
  const fs = await import('node:fs');
  const tmp = '/tmp/antigravity-proxy-test-config.json';
  fs.writeFileSync(tmp, JSON.stringify({ listen: { port: 7000 } }));
  const config = loadConfig({ configPath: tmp, env: {} });
  assert.equal(config.listen.port, 7000);
});

test('account pool rotates and cools down', () => {
  const pool = new AccountPool({ logger: console });
  const accounts = [{ id: 'a' }, { id: 'b' }];
  assert.equal(pool.pick(accounts).id, 'a');
  assert.equal(pool.pick(accounts).id, 'b');
  assert.equal(pool.pick(accounts).id, 'a');
  pool.cooldown('a', 60_000);
  assert.equal(pool.pick(accounts).id, 'b');
  assert.equal(pool.pick(accounts).id, 'b');
});
