import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { loadConfig } from '../src/config/load-config.js';
import { createLogger } from '../src/utils/logger.js';
import { CredentialStore } from '../src/credentials/credential-store.js';
import { UpstreamClient } from '../src/upstream/upstream-client.js';
import { AccountPool } from '../src/upstream/account-pool.js';
import { createServer } from '../src/server/create-server.js';

const CONFIG = loadConfig({ env: { ANTIGRAVITY_PROXY_PORT: '0', ANTIGRAVITY_PROXY_LOG_LEVEL: 'error' } });

// fake antigravity upstream: project p-hung never answers, p-slow answers after 300 ms, others at once
function fakeUpstream() {
  const projects = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { project } = JSON.parse(body);
      projects.push(project);
      if (project === 'p-hung') return;
      const reply = () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: `pong:${project}` }] }, finishReason: 'STOP' }] } }));
      };
      if (project === 'p-slow') setTimeout(reply, 300);
      else reply();
    });
  });
  return { server, projects };
}

function fakeVertex() {
  return http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-vtx', object: 'chat.completion', created: 1, model: 'gemini-3.8-flash',
        choices: [{ index: 0, message: { role: 'assistant', content: 'vertex-ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
}

async function startStack(projectIds) {
  const upstream = fakeUpstream();
  await once(upstream.server.listen(0), 'listening');
  const vertex = fakeVertex();
  await once(vertex.listen(0), 'listening');

  const logger = createLogger('error');
  const store = new CredentialStore({ searchPaths: [], logger });
  store.readAll = () => projectIds.map((projectId, i) => ({ id: `a${i}`, email: `a${i}@x`, projectId }));
  const config = {
    ...CONFIG,
    upstream: { ...CONFIG.upstream, baseUrl: `http://127.0.0.1:${upstream.server.address().port}`, apiVersion: 'v1internal', eagerRefreshMs: 0, egress: { url: null } },
    fallback: { vertexUrl: `http://127.0.0.1:${vertex.address().port}/v1/chat/completions`, enabled: true, timeoutMs: 5000 },
  };
  const upstreamClient = new UpstreamClient({ config, logger });
  upstreamClient.accessToken = async () => 'test-token';
  const server = createServer({ config, credentialStore: store, upstream: upstreamClient, pool: new AccountPool({ logger }), logger });
  await once(server.listen(0), 'listening');
  const close = () => {
    for (const s of [server, upstream.server, vertex]) { s.closeAllConnections(); s.close(); }
  };
  return { port: server.address().port, projects: upstream.projects, close };
}

async function chat(port, headers = {}) {
  const started = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'gemini-3.8-flash-low', messages: [{ role: 'user', content: 'hi' }] }),
  });
  const json = await res.json();
  return { status: res.status, content: json.choices?.[0]?.message?.content, elapsedMs: Date.now() - started };
}

test('a hung account is cut after its attempt budget and the next account answers', async () => {
  const stack = await startStack(['p-hung', 'p-ok']);
  try {
    const res = await chat(stack.port, { 'x-attempt-timeouts-ms': '200,200' });
    assert.equal(res.status, 200);
    assert.equal(res.content, 'pong:p-ok');
    assert.ok(res.elapsedMs >= 200 && res.elapsedMs < 3000, `elapsed ${res.elapsedMs}ms`);
    assert.deepEqual(stack.projects, ['p-hung', 'p-ok']);
  } finally {
    stack.close();
  }
});

test('when every account hangs, the Vertex relay answers', async () => {
  const stack = await startStack(['p-hung', 'p-hung']);
  try {
    const res = await chat(stack.port, { 'x-attempt-timeouts-ms': '150,100' });
    assert.equal(res.status, 200);
    assert.equal(res.content, 'vertex-ok');
    assert.equal(stack.projects.length, 2);
    assert.ok(res.elapsedMs < 3000, `elapsed ${res.elapsedMs}ms`);
  } finally {
    stack.close();
  }
});

test('without the header, or with a malformed one, a slow account is not cut', async () => {
  const stack = await startStack(['p-slow', 'p-ok']);
  try {
    assert.equal((await chat(stack.port)).content, 'pong:p-slow');
    assert.equal((await chat(stack.port, { 'x-attempt-timeouts-ms': 'soon' })).content, 'pong:p-ok');
    assert.equal((await chat(stack.port, { 'x-attempt-timeouts-ms': '100,abc' })).content, 'pong:p-slow');
  } finally {
    stack.close();
  }
});
