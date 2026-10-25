// Scoped pool state: request-local tried avoidance is separate from shared restrictions, every
// restriction is narrow, expiry admits exactly one bounded probe, and only a newer-evidence-aware
// success can recover a scope. Synthetic accounts only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountPool } from '../src/upstream/account-pool.js';

const logger = { info() {}, warn() {}, error() {} };
const MODEL_X = 'gemini-3.8-flash-high';
const MODEL_Y = 'gemini-3.8-flash-low';

function setup(accounts = [
  { id: '/creds/a.json', generation: 'ga', projectId: 'project-a' },
  { id: '/creds/b.json', generation: 'gb', projectId: 'project-b' },
]) {
  let now = 10_000;
  const pool = new AccountPool({ logger, now: () => now });
  const contextFor = (account) => ({ ...accounts.find((entry) => entry.id === account.id) });
  const advance = (ms) => { now += ms; };
  return { pool, accounts, now: () => now, advance, contextFor };
}

test('selection stays sticky-first and a request-local tried set never writes shared state', () => {
  const { pool, accounts, contextFor } = setup();
  assert.equal(pool.select(accounts, { context: contextFor }).account.id, '/creds/a.json');
  assert.equal(pool.select(accounts, { context: contextFor }).account.id, '/creds/a.json');
  const second = pool.select(accounts, { tried: new Set(['/creds/a.json']), context: contextFor });
  assert.equal(second.account.id, '/creds/b.json');
  assert.equal(pool.snapshot().restricted, false, 'tried is request-local only');
});

test('an account_model restriction does not block another model or another account', () => {
  const { pool, accounts, now, contextFor } = setup();
  pool.restrict({
    accountId: '/creds/a.json', scope: 'account_model', model: MODEL_X,
    until: now() + 60_000, reason: 'scoped_quota', evidence: 'pool_gate',
  });
  const sameModel = pool.select(accounts, { context: (a) => ({ ...contextFor(a), model: MODEL_X }) });
  assert.equal(sameModel.account.id, '/creds/b.json');
  const otherModel = pool.select(accounts, { context: (a) => ({ ...contextFor(a), model: MODEL_Y }) });
  assert.equal(otherModel.account.id, '/creds/a.json', 'A/model-Y is independent of A/model-X');
});

test('an account restriction covers every model of that account', () => {
  const { pool, accounts, now, contextFor } = setup();
  pool.restrict({
    accountId: '/creds/a.json', scope: 'account', until: now() + 60_000,
    reason: 'account_restricted', evidence: 'pool_gate',
  });
  for (const model of [MODEL_X, MODEL_Y]) {
    assert.equal(pool.select(accounts, { context: (a) => ({ ...contextFor(a), model }) }).account.id, '/creds/b.json');
  }
});

test('a project gate blocks accounts sharing that project, not another project', () => {
  const accounts = [
    { id: '/creds/a.json', generation: 'ga', projectId: 'shared-project' },
    { id: '/creds/b.json', generation: 'gb', projectId: 'shared-project' },
    { id: '/creds/c.json', generation: 'gc', projectId: 'other-project' },
  ];
  const { pool, now } = setup(accounts);
  pool.restrict({
    projectId: 'shared-project', scope: 'project', until: now() + 60_000,
    reason: 'project_restricted', evidence: 'pool_gate',
  });
  const selection = pool.select(accounts, { context: (a) => ({ ...a }) });
  assert.equal(selection.account.id, '/creds/c.json');
  assert.equal(selection.counts.resourceGated, 2, 'both members of the gated project are excluded');
  assert.ok(selection.exclusions.every((entry) => entry.code === 'resource_gated' || entry.code === 'tried'));
});

test('a resolved project gate is checked immediately before dispatch', () => {
  const accounts = [{ id: '/creds/a.json', generation: 'ga' }];
  const { pool, now } = setup(accounts);
  pool.restrict({
    projectId: 'late-project', scope: 'project', until: now() + 60_000,
    reason: 'project_restricted', evidence: 'pool_gate',
  });
  const selection = pool.select(accounts, { context: (a) => ({ ...a, projectId: null }) });
  assert.equal(selection.account.id, '/creds/a.json', 'the project is unknown at selection');
  const gate = pool.gateFor(selection.account, { ...selection.context, projectId: 'late-project' }, selection);
  assert.equal(gate.scope, 'project');
  assert.equal(pool.gateFor(selection.account, { ...selection.context, projectId: 'independent-project' }, selection), null);
});

test('an egress gate is per effective egress identity, including the authenticated session', () => {
  const first = 'socks5://alice:secret@proxy.example:1080';
  const second = 'socks5://bob:other@proxy.example:1080';
  const accounts = [
    { id: '/creds/a.json', generation: 'ga' },
    { id: '/creds/b.json', generation: 'gb' },
    { id: '/creds/c.json', generation: 'gc' },
  ];
  const { pool, now } = setup(accounts);
  const egress = {
    '/creds/a.json': { key: first, alias: 'egress-aaaaaaaa' },
    '/creds/b.json': { key: first, alias: 'egress-aaaaaaaa' },
    '/creds/c.json': { key: second, alias: 'egress-bbbbbbbb' },
  };
  pool.restrict({
    scope: 'egress', egressKey: first, egressAlias: 'egress-aaaaaaaa',
    until: now() + 30_000, reason: 'egress_unavailable', evidence: 'egress_connect',
  });
  const selection = pool.select(accounts, {
    context: (a) => ({ ...a, egressKey: egress[a.id].key, egressAlias: egress[a.id].alias }),
  });
  assert.equal(selection.account.id, '/creds/c.json', 'the same host:port with another session stays eligible');
  assert.equal(selection.counts.egressGated, 2);
});

test('a revoked credential generation is blocked until the material changes', () => {
  const accounts = [
    { id: '/creds/a.json', generation: 'g1' },
    { id: '/creds/b.json', generation: 'gb' },
  ];
  const { pool } = setup(accounts);
  const applied = pool.blockGeneration({
    accountId: '/creds/a.json', generation: 'g1', reason: 'revoked_credential', evidence: 'oauth_invalid_grant',
  });
  assert.equal(applied.applied, true);
  assert.equal(pool.select(accounts, { context: (a) => ({ ...a }) }).account.id, '/creds/b.json');
  // A normal access-token refresh keeps the generation: still blocked.
  const sameGeneration = accounts.map((a) => (a.id === '/creds/a.json' ? { ...a } : a));
  assert.equal(pool.select(sameGeneration, { context: (a) => ({ ...a }) }).account.id, '/creds/b.json');
  // A new refresh token at the same path is new material: selectable again without a timer.
  const replaced = accounts.map((a) => (a.id === '/creds/a.json' ? { ...a, generation: 'g2' } : a));
  assert.equal(pool.select(replaced, { context: (a) => ({ ...a }) }).account.id, '/creds/a.json');
  // No generation cannot prove replacement: stay conservative.
  assert.equal(pool.select([{ id: '/creds/a.json' }], { context: () => ({ generation: null }) }).account, null);
  assert.equal(pool.blockGeneration({ accountId: '/creds/a.json' }).applied, false);
});

test('concurrent cooldown reports extend monotonically and never shorten newer evidence', () => {
  const { pool, accounts, now } = setup([{ id: '/creds/a.json', generation: 'ga' }]);
  const later = now() + 60_000;
  pool.restrict({ accountId: '/creds/a.json', scope: 'account', until: later, reason: 'account_restricted', evidence: 'pool_gate' });
  const shortened = pool.restrict({ accountId: '/creds/a.json', scope: 'account', until: now() + 1_000, reason: 'account_restricted', evidence: 'pool_gate' });
  assert.equal(shortened.applied, false);
  assert.equal(shortened.effect, 'not_shortened');
  assert.equal(pool.select(accounts, { context: (a) => ({ ...a }) }).account, null, 'the later gate survives');
  const extendedTo = now() + 120_000;
  const extended = pool.restrict({ accountId: '/creds/a.json', scope: 'account', until: extendedTo, reason: 'account_restricted', evidence: 'pool_gate' });
  assert.equal(extended.effect, 'extended');
  const record = pool.snapshot().restrictions.find((entry) => entry.scope === 'account');
  assert.equal(record.until, new Date(extendedTo).toISOString());
});

test('expiry admits exactly one bounded probe and release is not recovery', () => {
  const accounts = [{ id: '/creds/a.json', generation: 'ga' }];
  const { pool, now, advance } = setup(accounts);
  pool.restrict({
    accountId: '/creds/a.json', scope: 'account', until: now() + 1_000,
    reason: 'account_restricted', evidence: 'pool_gate',
  });
  assert.equal(pool.select(accounts, { context: (a) => ({ ...a }) }).account, null, 'not before expiry');
  advance(1_001);
  const probe = pool.select(accounts, { context: (a) => ({ ...a }) });
  assert.equal(probe.account.id, '/creds/a.json');
  assert.equal(probe.probes.length, 1);
  assert.equal(pool.select(accounts, { context: (a) => ({ ...a }) }).account, null, 'one probe at a time');
  assert.equal(pool.select(accounts, { context: (a) => ({ ...a }) }).exclusions.at(-1).code, 'probe_busy');
  pool.releaseProbe(probe);
  assert.equal(pool.snapshot().restrictions[0].state, 'expired_probe_eligible', 'release/cancel does not clear');
  assert.equal(pool.select(accounts, { context: (a) => ({ ...a }) }).account.id, '/creds/a.json', 'the next request may probe again');
});

test('a successful probe clears only unchanged evidence; a late success cannot erase a newer gate', () => {
  const accounts = [{ id: '/creds/a.json', generation: 'ga' }];
  const { pool, now, advance } = setup(accounts);
  pool.restrict({
    accountId: '/creds/a.json', scope: 'account', until: now() + 100,
    reason: 'account_restricted', evidence: 'pool_gate',
  });
  advance(101);
  const probe = pool.select(accounts, { context: (a) => ({ ...a }) });
  // A newer cooldown arrives while the probe is in flight.
  const newer = now() + 5_000;
  pool.restrict({ accountId: '/creds/a.json', scope: 'account', until: newer, reason: 'account_restricted', evidence: 'pool_gate' });
  const recovered = pool.recoverProbe(probe, { generation: 'ga' });
  assert.deepEqual(recovered, []);
  assert.equal(pool.select(accounts, { context: (a) => ({ ...a }) }).account, null, 'the newer gate survives');
  assert.equal(pool.snapshot().restrictions[0].until, new Date(newer).toISOString());

  advance(5_001);
  const cleanProbe = pool.select(accounts, { context: (a) => ({ ...a }) });
  const cleared = pool.recoverProbe(cleanProbe, { generation: 'ga' });
  assert.equal(cleared.length, 1);
  assert.equal(pool.snapshot().restricted, false, 'a real success recovers the scope');
});

test('the operator snapshot exposes aliases and enums only', () => {
  const accounts = [{
    id: '/home/sentinel/.config/creds/sentinel-token.json',
    generation: 'secret-generation',
    projectId: 'SENTINEL_PROJECT_ID',
  }];
  const { pool, now } = setup(accounts);
  pool.restrict({
    accountId: accounts[0].id, scope: 'account_model', model: MODEL_X,
    until: now() + 10_000, reason: 'scoped_quota', evidence: 'pool_gate',
  });
  pool.restrict({
    scope: 'egress', egressKey: 'socks5://user:SENTINEL_PROXY_PASSWORD@proxy:1080',
    egressAlias: 'egress-12345678', until: now() + 10_000,
    reason: 'egress_unavailable', evidence: 'egress_connect',
  });
  pool.restrict({
    projectId: accounts[0].projectId, scope: 'project', until: now() + 10_000,
    reason: 'project_restricted', evidence: 'pool_gate',
  });
  pool.blockGeneration({
    accountId: accounts[0].id, generation: 'secret-generation',
    reason: 'revoked_credential', evidence: 'oauth_invalid_grant',
  });
  const snapshot = pool.snapshot(accounts);
  const text = JSON.stringify(snapshot);
  for (const secret of ['/home/sentinel', 'sentinel-token.json', 'SENTINEL_PROJECT_ID',
    'SENTINEL_PROXY_PASSWORD', 'secret-generation', 'user:']) {
    assert.equal(text.includes(secret), false, `snapshot leaked ${secret}`);
  }
  assert.match(text, /acct-[0-9a-f]{8}/);
  assert.match(text, /egress-12345678/);
  assert.match(text, /project-[0-9a-f]{8}/);
  assert.equal(snapshot.credentialBlocks[0].state, 'blocked');
});

test('the coarse healthy() view ignores egress/project gates it cannot attribute', () => {
  const accounts = [
    { id: '/creds/a.json', generation: 'ga' },
    { id: '/creds/b.json', generation: 'gb' },
  ];
  const { pool, now } = setup(accounts);
  pool.restrict({
    accountId: '/creds/a.json', scope: 'account', until: now() + 10_000,
    reason: 'account_restricted', evidence: 'pool_gate',
  });
  assert.deepEqual(pool.healthy(accounts).map((a) => a.id), ['/creds/b.json']);
  pool.restrict({
    scope: 'egress', egressKey: 'socks5://proxy:1080', egressAlias: 'egress-xx',
    until: now() + 10_000, reason: 'egress_unavailable', evidence: 'egress_connect',
  });
  assert.deepEqual(pool.healthy(accounts).map((a) => a.id), ['/creds/b.json'], 'selection, not healthy(), applies egress');
});
