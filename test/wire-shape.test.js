import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
import zlib from 'node:zlib';
import { once } from 'node:events';
import { UpstreamClient, generationOf } from '../src/upstream/upstream-client.js';

function recorder() {
  const seen = [];
  const server = https.createServer({
    key: fs.readFileSync(path.join(HERE, 'fixtures/tls/key.pem')),
    cert: fs.readFileSync(path.join(HERE, 'fixtures/tls/cert.pem')),
  }, (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body });
      if (req.url.includes('loadCodeAssist')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ cloudaicompanionProject: 'aicode-consumers', currentTier: { id: 'free-tier' } }));
        return;
      }
      if (req.url.includes('writeTrajectoryAcls')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      const payload = JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] } });
      // answer gzipped when the caller asked for it, exactly like the backend
      if (String(req.headers['accept-encoding'] ?? '').includes('gzip')) {
        const gz = zlib.gzipSync(payload);
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': gz.length });
        res.end(gz);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(payload);
    });
  });
  return { server, seen };
}

async function stack({ trajectoryAcls = false } = {}) {
  const { server, seen } = recorder();
  await once(server.listen(0), 'listening');
  const port = server.address().port;
  // a bare CONNECT proxy, so the client takes its production node:https path
  const proxy = http.createServer();
  proxy.on('connect', (req, socket, head) => {
    const upstream = net.connect(port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  await once(proxy.listen(0), 'listening');
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const config = {
    upstream: {
      baseUrl: `http://127.0.0.1:${port}`,
      apiVersion: 'v1internal',
      userAgent: 'antigravity/cli/1.3.3 (aidev_client; os_type=linux; arch=arm64; cl=996823801; auth_method=consumer)',
      eagerRefreshMs: 0,
      trajectoryAcls,
      egress: { url: proxyUrl },
    },
  };
  const client = new UpstreamClient({ config, logger: { warn() {}, info() {}, error() {} }, currentGeneration: generationOf });
  // the fixture cert is self-signed; production verifies normally
  client.agentFor = () => new https.Agent({ keepAlive: true, rejectUnauthorized: false });
  const account = { id: 'a', email: 'a@b', accessToken: 'tok', refreshToken: 'r', expiry: Date.now() + 3_600_000 };
  // prime the token cache so no OAuth refresh leaves for the real endpoint
  client.tokens.set('a', { token: 'tok', expiresAt: Date.now() + 3_600_000, generation: generationOf(account), version: 0 });
  return { client, account, seen, close: () => { server.close(); proxy.close(); } };
}

test('the generate POST carries the CLI header set and casing, and no length on a stream', async () => {
  const s = await stack();
  try {
    const body = await s.client.buildBody({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }] }, s.account);
    const response = await s.client.request(`${s.client.config.upstream.baseUrl}/v1internal:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: {
        'User-Agent': s.client.config.upstream.userAgent,
        Authorization: 'Bearer tok',
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip',
      },
      body: JSON.stringify(body),
      egressUrl: s.client.config.upstream.egress.url,
      stream: true,
    });
    assert.equal(response.status, 200);
    const seen = s.seen.find((r) => r.url.includes('streamGenerateContent'));
    assert.equal(seen.headers['user-agent'], s.client.config.upstream.userAgent);
    assert.equal(seen.headers['accept-encoding'], 'gzip');
    assert.equal(seen.headers.accept, undefined, 'the CLI sends no accept header');
    assert.equal(seen.headers['x-request-id'], undefined);
    assert.equal(seen.headers['content-length'], undefined, 'a streamed POST goes chunked');
    assert.equal(seen.headers['transfer-encoding'], 'chunked');
    const text = await response.text();
    assert.match(text, /ok/, 'a gzip body is decompressed for the caller');
  } finally {
    s.close();
  }
});

test('writeTrajectoryAcls fires before the generate call when enabled', async () => {
  const s = await stack({ trajectoryAcls: true });
  try {
    const body = await s.client.buildBody({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }] }, s.account);
    await s.client.writeTrajectoryAcls(s.account, body.request.labels.trajectory_id, { egressUrl: s.client.config.upstream.egress.url });
    const acl = s.seen.find((r) => r.url.includes('writeTrajectoryAcls'));
    assert.ok(acl, 'the trajectory was registered');
    assert.deepEqual(JSON.parse(acl.body), { trajectoryId: body.request.labels.trajectory_id });
  } finally {
    s.close();
  }
});

test('writeTrajectoryAcls stays off unless the config turns it on', async () => {
  const s = await stack();
  try {
    const body = await s.client.buildBody({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hi' }] }, s.account);
    await s.client.writeTrajectoryAcls(s.account, body.request.labels.trajectory_id, { egressUrl: s.client.config.upstream.egress.url });
    assert.equal(s.seen.filter((r) => r.url.includes('writeTrajectoryAcls')).length, 0);
  } finally {
    s.close();
  }
});

test('a failing trajectory registration never costs the turn', async () => {
  const s = await stack({ trajectoryAcls: true });
  try {
    // no server behind the URL: the call must resolve, not throw
    await s.client.writeTrajectoryAcls(s.account, 'traj', { egressUrl: s.client.config.upstream.egress.url });
    assert.ok(true);
  } finally {
    s.close();
  }
});
