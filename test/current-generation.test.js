import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialStore } from '../src/credentials/credential-store.js';
import { UpstreamClient } from '../src/upstream/upstream-client.js';

const logger = { info() {}, warn() {}, error() {} };
const config = { upstream: {
  baseUrl: 'http://127.0.0.1:1', apiVersion: 'v1internal', userAgent: 'synthetic',
  requestTimeoutMs: 2000, eagerRefreshMs: 0, egress: { url: null },
} };
const token = (value) => ({ ok: true, status: 200, json: async () => ({ access_token: value, expires_in: 3600 }) });
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-owner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'credential.json');
  const replace = (generation) => fs.writeFileSync(file, JSON.stringify({ access_token: 'synthetic', refresh_token: `synthetic-${generation}` }));
  replace('g1');
  const store = new CredentialStore({ searchPaths: [file], logger });
  const snapshot = () => store.readAll()[0];
  const client = new UpstreamClient({ config, logger,
    currentGeneration: (account) => store.readAll().find((entry) => entry.id === account.id)?.generation,
  });
  return { file, replace, snapshot, client };
}
const replaced = (error) => error.reason === 'credential_replaced';
const unavailable = (error) => error.reason === 'invalid_local_config' && error.publicStatus === 503;

test('an old snapshot starting after replacement cannot refresh or overwrite the new cache', async (t) => {
  const f = fixture(t);
  const old = f.snapshot();
  f.replace('g2');
  const current = f.snapshot();
  await f.client.accessToken(current, { fetchImpl: async () => token('token-g2') });
  let calls = 0;
  await assert.rejects(f.client.accessToken(old, { fetchImpl: async () => { calls++; return token('token-g1'); } }), replaced);
  assert.equal(calls, 0);
  assert.equal(f.client.tokens.get(old.id).token, 'token-g2');
  let tokenCalls = 0;
  f.client.accessToken = async () => { tokenCalls++; return 'synthetic'; };
  await assert.rejects(f.client.ensureProject(old), replaced);
  await assert.rejects(f.client.ensureProject({ ...old, projectId: 'old-project' }), replaced);
  assert.equal(tokenCalls, 0, 'project ownership is checked before token acquisition and cached project return');
});

test('replacement while OAuth is in flight prevents the old result writing any cache', async (t) => {
  const f = fixture(t);
  const old = f.snapshot();
  const gate = deferred();
  const started = deferred();
  const pending = f.client.accessToken(old, { fetchImpl: () => { started.resolve(); return gate.promise; } });
  const failure = assert.rejects(pending, replaced);
  await started.promise;
  f.replace('g2');
  await f.client.accessToken(f.snapshot(), { fetchImpl: async () => token('token-g2') });
  gate.resolve(token('token-g1'));
  await failure;
  assert.equal(f.client.tokens.get(old.id).token, 'token-g2');
});

test('replacement during project body read preserves the current project and old snapshot', async (t) => {
  const f = fixture(t);
  const old = f.snapshot();
  const gate = deferred();
  const reading = deferred();
  f.client.accessToken = async () => 'synthetic';
  f.client.request = async () => ({ ok: true, json: () => { reading.resolve(); return gate.promise; } });
  const pending = f.client.ensureProject(old);
  const failure = assert.rejects(pending, replaced);
  await reading.promise;
  f.replace('g2');
  f.client.request = async () => ({ ok: true, json: async () => ({ project: 'project-g2' }) });
  await f.client.ensureProject(f.snapshot());
  gate.resolve({ project: 'project-g1' });
  await failure;
  assert.equal(f.client.projects.get(old.id).projectId, 'project-g2');
  assert.equal(old.projectId, null);
});

test('missing, unavailable and absent ownership resolver fail closed before cached token return', async (t) => {
  const f = fixture(t);
  const old = f.snapshot();
  await f.client.accessToken(old, { fetchImpl: async () => token('token-g1') });
  fs.unlinkSync(f.file);
  await assert.rejects(f.client.accessToken(old), unavailable);
  await assert.rejects(f.client.ensureProject(old), unavailable);
  assert.equal(f.client.tokens.get(old.id).token, 'token-g1');
  const noResolver = new UpstreamClient({ config, logger });
  await assert.rejects(noResolver.accessToken(old), unavailable);
  f.client.currentGeneration = () => undefined;
  await assert.rejects(f.client.accessToken(old), unavailable);
});

test('ownership lookup failing after OAuth does not commit the response', async (t) => {
  const f = fixture(t);
  const old = f.snapshot();
  await assert.rejects(f.client.accessToken(old, { fetchImpl: async () => {
    f.client.currentGeneration = () => { throw new Error('synthetic unavailable'); };
    return token('do-not-cache');
  } }), unavailable);
  assert.equal(f.client.tokens.size, 0);
});

test('a partial credential rewrite retains the existing lastGood owner', async (t) => {
  const f = fixture(t);
  const old = f.snapshot();
  fs.writeFileSync(f.file, '{');
  assert.equal(await f.client.accessToken(old, { fetchImpl: async () => token('synthetic-token') }), 'synthetic-token');
});
