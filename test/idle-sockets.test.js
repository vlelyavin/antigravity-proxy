import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { dropIdleSockets, makeEgressAgent } from '../src/upstream/egress.js';
import { loadConfig } from '../src/config/load-config.js';
import { createLogger } from '../src/utils/logger.js';
import { UpstreamClient } from '../src/upstream/upstream-client.js';

// socks5 relay (no auth): answers the handshake, then pipes to the requested target
function relaySocks5() {
  return net.createServer((client) => {
    let buffer = Buffer.alloc(0);
    let stage = 'greet';
    client.on('error', () => client.destroy());
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'greet') {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
        buffer = buffer.subarray(2 + buffer[1]);
        client.write(Buffer.from([0x05, 0x00]));
        stage = 'connect';
      }
      if (stage !== 'connect' || buffer.length < 5 || buffer[3] !== 0x03) return;
      const end = 5 + buffer[4];
      if (buffer.length < end + 2) return;
      const host = buffer.subarray(5, end).toString();
      const port = buffer.readUInt16BE(end);
      stage = 'relay';
      client.off('data', onData);
      const upstream = net.connect({ host, port }, () => {
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        client.pipe(upstream).pipe(client);
      });
      upstream.on('error', () => client.destroy());
      upstream.on('close', () => client.destroy());
      client.on('close', () => upstream.destroy());
    };
    client.on('data', onData);
  });
}

// keep-alive target that never closes idle connections itself; records each connection's fate
async function target() {
  const connections = [];
  const server = http.createServer((req, res) => {
    const reply = () => res.end('ok');
    if (req.url === '/slow') setTimeout(reply, 300);
    else reply();
  });
  server.keepAliveTimeout = 60_000;
  server.on('connection', (socket) => {
    const entry = { closed: false };
    connections.push(entry);
    socket.on('close', () => { entry.closed = true; });
  });
  await once(server.listen(0, '127.0.0.1'), 'listening');
  return { server, connections, port: server.address().port };
}

function get(agent, port, path = '/') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, agent }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

const freeCount = (agent) => Object.values(agent.freeSockets).flat().length;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function stack(idleSocketTimeoutMs) {
  const socks = relaySocks5();
  await once(socks.listen(0, '127.0.0.1'), 'listening');
  const upstream = await target();
  const agent = makeEgressAgent({
    egressUrl: `socks5://127.0.0.1:${socks.address().port}`,
    protocol: 'http:',
    idleSocketTimeoutMs,
  });
  const close = () => {
    agent.destroy();
    upstream.server.closeAllConnections();
    upstream.server.close();
    socks.close();
  };
  return { agent, upstream, close };
}

test('an idle pooled egress socket is closed after the idle timeout', async () => {
  const { agent, upstream, close } = await stack(100);
  try {
    assert.equal(await get(agent, upstream.port), 200);
    await sleep(20);
    assert.equal(freeCount(agent), 1, 'the socket is pooled after the response');
    await sleep(400);
    assert.equal(freeCount(agent), 0);
    assert.equal(upstream.connections[0].closed, true);
  } finally {
    close();
  }
});

test('without the idle timeout elapsing the pooled socket stays for reuse', async () => {
  const { agent, upstream, close } = await stack(10_000);
  try {
    assert.equal(await get(agent, upstream.port), 200);
    await sleep(400);
    assert.equal(freeCount(agent), 1);
    assert.equal(upstream.connections[0].closed, false);
    assert.equal(await get(agent, upstream.port), 200);
    assert.equal(upstream.connections.length, 1, 'second request reused the pooled socket');
  } finally {
    close();
  }
});

test('dropIdleSockets closes pooled sockets and leaves in-flight ones', async () => {
  const { agent, upstream, close } = await stack(10_000);
  try {
    const slow = get(agent, upstream.port, '/slow');
    await sleep(50);
    assert.equal(await get(agent, upstream.port), 200);
    await sleep(20);
    assert.equal(freeCount(agent), 1);
    dropIdleSockets(agent);
    await sleep(50);
    assert.equal(freeCount(agent), 0);
    assert.equal(upstream.connections.filter((c) => c.closed).length, 1);
    assert.equal(await slow, 200, 'the in-flight request completes');
  } finally {
    close();
  }
});

test('a pre-flight network failure retries after dropping pooled sockets', async () => {
  const config = loadConfig({ env: { ANTIGRAVITY_PROXY_LOG_LEVEL: 'error' } });
  const client = new UpstreamClient({ config, logger: createLogger('error') });
  const order = [];
  client.agents.set('socks5://egress', { freeSockets: { 'upstream:443:': [{ destroy: () => order.push('drop') }] } });
  client.accessToken = async () => 'token';
  client.buildBody = async () => ({});
  let calls = 0;
  client.request = async () => {
    calls += 1;
    order.push(`request${calls}`);
    if (calls === 1) throw new Error('socket hang up');
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
  };
  const response = await client.generate({ openAiBody: { model: 'gemini-3.8-flash-low' }, account: { id: 'a' } });
  assert.equal(response.status, 200);
  assert.deepEqual(order, ['request1', 'drop', 'request2']);
});
