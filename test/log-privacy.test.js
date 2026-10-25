// The journal is payload-free: no prompt text, no upstream body, no refusal text, no email, no
// credential path, no project id, no token. One synthetic sentinel per site, asserted on the real
// formatted journal lines the process writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { loadConfig } from '../src/config/load-config.js';
import { createLogger } from '../src/utils/logger.js';
import { accountLabel } from '../src/utils/alias.js';
import { CredentialStore } from '../src/credentials/credential-store.js';
import { UpstreamClient } from '../src/upstream/upstream-client.js';
import { AccountPool } from '../src/upstream/account-pool.js';
import { createServer } from '../src/server/create-server.js';

const CONFIG = loadConfig({ env: { ANTIGRAVITY_PROXY_PORT: '0', ANTIGRAVITY_PROXY_LOG_LEVEL: 'error' } });

/** A real logger writing into an in-memory sink, so the assertions see the exact journal text. */
function journal() {
  const lines = [];
  const logger = createLogger('debug', { write: (line) => { lines.push(line); } });
  return { logger, lines, text: () => lines.join('') };
}

function assertAbsent(text, secrets) {
  for (const secret of secrets) {
    assert.equal(text.includes(secret), false, `the journal leaked ${JSON.stringify(secret)}:\n${text}`);
  }
}

async function startRelay({ accounts, respond, logger }) {
  const upstreamServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => respond(res, body));
  });
  await once(upstreamServer.listen(0), 'listening');
  const config = {
    ...CONFIG,
    upstream: {
      ...CONFIG.upstream,
      baseUrl: `http://127.0.0.1:${upstreamServer.address().port}`,
      apiVersion: 'v1internal',
      requestTimeoutMs: 2000,
      eagerRefreshMs: 0,
      egress: { url: null },
    },
    rotation: { ...CONFIG.rotation, cooldownMs: 45_000, requestDeadlineMs: 5000 },
    fallback: { enabled: false },
  };
  const client = new UpstreamClient({ config, logger });
  client.accessToken = async () => 'SENTINEL_ACCESS_TOKEN';
  const server = createServer({ config, credentialStore: { readAll: () => accounts }, upstream: client, pool: new AccountPool({ logger }), logger });
  await once(server.listen(0), 'listening');
  const close = () => {
    for (const s of [server, upstreamServer]) { s.closeAllConnections(); s.close(); }
  };
  return { port: server.address().port, close };
}

async function chat(port, content = 'SENTINEL_PROMPT_TEXT') {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content }] }),
  });
  return { status: res.status, text: await res.text() };
}

const ACCOUNT = {
  id: '/home/sentinel/.config/creds/sentinel-token.json',
  email: 'sentinel@example.test',
  projectId: 'SENTINEL_PROJECT_ID',
};

test('a transient upstream failure journals the category, not the body, the email or the path', async () => {
  const sink = journal();
  const stack = await startRelay({
    accounts: [ACCOUNT],
    logger: sink.logger,
    respond: (res) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 502, message: 'SENTINEL_UPSTREAM_BODY', status: 'UNAVAILABLE' } }));
    },
  });
  try {
    const res = await chat(stack.port);
    assert.equal(res.status, 502);
    const text = sink.text();
    assert.match(text, /rotation\.transient/);
    assert.match(text, new RegExp(`account=${JSON.stringify(accountLabel(ACCOUNT))}`));
    assert.match(text, /status=502/);
    assertAbsent(text, ['SENTINEL_UPSTREAM_BODY', 'SENTINEL_PROMPT_TEXT', 'SENTINEL_PROJECT_ID',
      'sentinel@example.test', 'sentinel-token.json', '/home/sentinel', 'SENTINEL_ACCESS_TOKEN']);
    // the timing lines stay usable: a request id, an attempt number and the classification
    assert.match(text, /attempt\.timing .*requestId="req-/);
    assert.match(text, /attempt\.timing .*outcome="transient"/);
    assert.match(text, /request\.timing .*outcome="failed"/);
    assert.match(text, /request\.timing .*reason="other:502"/);
  } finally {
    stack.close();
  }
});

test('a refusal is journaled as a boolean, its text stays in the client response only', async () => {
  const sink = journal();
  const stack = await startRelay({
    accounts: [ACCOUNT],
    logger: sink.logger,
    respond: (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ response: { promptFeedback: { blockReason: 'PROHIBITED_CONTENT', blockReasonMessage: 'SENTINEL_REFUSAL_TEXT' } } })}\n\n`);
    },
  });
  try {
    const res = await chat(stack.port);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.text);
    // the caller keeps the API semantics it needs to tell a refusal from a glitch
    assert.match(body.choices[0].message.refusal, /SENTINEL_REFUSAL_TEXT/);
    assert.equal(body.choices[0].finish_reason, 'content_filter');
    const text = sink.text();
    assert.match(text, /chat\.completed .*blocked=true/);
    assertAbsent(text, ['SENTINEL_REFUSAL_TEXT', 'PROHIBITED_CONTENT', 'sentinel@example.test', '/home/sentinel']);
  } finally {
    stack.close();
  }
});

test('the refresh and project paths journal the alias, never the token, email or project id', async () => {
  const sink = journal();
  const client = new UpstreamClient({ config: CONFIG, logger: sink.logger });
  const account = { id: '/home/sentinel/token.json', email: 'sentinel@example.test', refreshToken: 'SENTINEL_REFRESH_TOKEN' };
  const token = await client.accessToken(account, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'SENTINEL_ACCESS_TOKEN', expires_in: 3600 }) }),
  });
  assert.equal(token, 'SENTINEL_ACCESS_TOKEN');
  client.request = async () => ({ ok: true, json: async () => ({ cloudaicompanionProject: 'SENTINEL_PROJECT_ID' }) });
  client.accessToken = async () => 'SENTINEL_ACCESS_TOKEN';
  assert.equal(await client.ensureProject({ id: '/home/sentinel/token.json', email: 'sentinel@example.test' }), 'SENTINEL_PROJECT_ID');
  const text = sink.text();
  assert.match(text, /oauth\.refreshed/);
  assert.match(text, /project\.resolved/);
  assertAbsent(text, ['SENTINEL_REFRESH_TOKEN', 'SENTINEL_ACCESS_TOKEN', 'SENTINEL_PROJECT_ID',
    'sentinel@example.test', 'token.json', '/home/sentinel']);
  // the cache is untouched by the logging change
  assert.equal(client.projects.get('/home/sentinel/token.json'), 'SENTINEL_PROJECT_ID');
});

test('a credential file problem journals its alias and a category, not the file or its content', async () => {
  const sink = journal();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-privacy-'));
  const file = path.join(dir, 'sentinel-cred.json');
  try {
    await fs.writeFile(file, JSON.stringify({ access_token: 'SENTINEL_CREDENTIAL_TEXT', refresh_token: 'SENTINEL_REFRESH_TOKEN' }));
    const store = new CredentialStore({ searchPaths: [file], logger: sink.logger });
    assert.equal(store.readAll().length, 1, 'a readable file still loads');

    // the file is rewritten by another process: the last good snapshot takes over
    await fs.writeFile(file, '{"access_token": "SENTINEL_CREDENTIAL_TEXT",,,');
    assert.equal(store.readAll().length, 1);
    assert.match(sink.text(), /credentials\.partial_write_fallback/);

    // an unreadable file with no snapshot is reported by category only
    const unreadable = new CredentialStore({ searchPaths: [file], logger: sink.logger });
    assert.throws(() => unreadable.readAll(), /no antigravity token files found/);
    assert.match(sink.text(), /credentials\.unreadable/);
    assertAbsent(sink.text(), ['SENTINEL_CREDENTIAL_TEXT', 'SENTINEL_REFRESH_TOKEN', 'sentinel-cred.json', dir]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the startup credential line carries labels, not emails or paths', () => {
  const sink = journal();
  // the same shape cli.js writes
  sink.logger.info('credentials.loaded', {
    count: 1,
    accounts: [accountLabel(ACCOUNT)],
    projects: [ACCOUNT.projectId ? 'set' : 'missing'],
  });
  const text = sink.text();
  assert.match(text, new RegExp(`accounts=\\[${JSON.stringify(accountLabel(ACCOUNT))}\\]`));
  assert.match(text, /projects=\["set"\]/);
  assertAbsent(text, ['sentinel@example.test', 'sentinel-token.json', '/home/sentinel', 'SENTINEL_PROJECT_ID']);
});
