import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { loadConfig } from '../src/config/load-config.js';
import { createLogger } from '../src/utils/logger.js';
import { AccountPool } from '../src/upstream/account-pool.js';
import { createServer, readBody } from '../src/server/create-server.js';

const CONFIG = loadConfig({ env: { ANTIGRAVITY_PROXY_PORT: '0', ANTIGRAVITY_PROXY_LOG_LEVEL: 'error' } });

function echoServer(limitBytes) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    try {
      const body = await readBody(req, res, limitBytes);
      seen.push({ accepted: true, length: body.length });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ length: body.length }));
    } catch (error) {
      seen.push({ accepted: false, tooLarge: error.tooLarge === true, clientAborted: error.clientAborted === true });
      if (error.tooLarge || error.clientAborted) return; // the answer is already written / nobody is left
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  return { server, seen };
}

test('the body limit accepts exactly the limit and answers 413 one byte over it', async () => {
  const { server, seen } = echoServer(64);
  await once(server.listen(0), 'listening');
  const port = server.address().port;
  try {
    const exact = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: 'x'.repeat(64) });
    assert.equal(exact.status, 200);
    assert.deepEqual(await exact.json(), { length: 64 });

    const over = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: 'x'.repeat(65) });
    assert.equal(over.status, 413);
    assert.equal(over.headers.get('connection'), 'close');
    assert.equal((await over.json()).error.code, 413);

    assert.deepEqual(seen, [
      { accepted: true, length: 64 },
      { accepted: false, tooLarge: true, clientAborted: false },
    ]);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('a caller that disappears mid-upload is reported as such and leaves the server usable', async () => {
  const { server, seen } = echoServer(1024);
  await once(server.listen(0), 'listening');
  const port = server.address().port;
  try {
    const socket = net.connect({ host: '127.0.0.1', port });
    await once(socket, 'connect');
    socket.write('POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 4096\r\n\r\nhalf a bo');
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(seen, [{ accepted: false, tooLarge: false, clientAborted: true }]);

    const alive = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: 'still here' });
    assert.equal(alive.status, 200);
    assert.deepEqual(await alive.json(), { length: 10 });
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('the relay answers 413 for a body over 32 MiB and keeps serving', async () => {
  const logger = createLogger('error');
  let upstreamCalls = 0;
  const server = createServer({
    config: { ...CONFIG, fallback: { enabled: false } },
    credentialStore: { readAll: () => [{ id: 'a0', projectId: 'p' }] },
    upstream: {
      invalidate() {},
      async generateStream() {
        upstreamCalls += 1;
        return new Response('', { headers: { 'content-type': 'text/event-stream' } });
      },
    },
    pool: new AccountPool({ logger }),
    logger,
  });
  await once(server.listen(0), 'listening');
  const port = server.address().port;
  try {
    const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x'.repeat(32 * 1024 * 1024) }] });
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error.code, 413);
    assert.equal(upstreamCalls, 0, 'the oversized body never reaches the upstream');

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200, 'the relay survived the oversized upload');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
