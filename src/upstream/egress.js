// Outbound egress: optional socks5:// or http(s):// CONNECT proxy per config
// (upstream.egress.url). Mirrors CLIProxyAPI per-credential proxy behavior.
// Node stdlib has no socks client, so the socks5 CONNECT handshake is
// implemented directly on a net.Socket (RFC 1928: no-auth and user/pass).
import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';

export class EgressError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'EgressError';
  }
}

export function parseProxyUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new EgressError('invalid egress url: not a url');
  }
  const scheme = url.protocol.replace(':', '');
  if (!['socks5', 'socks5h', 'http', 'https'].includes(scheme)) {
    throw new EgressError(`invalid egress url: unsupported scheme ${scheme}`);
  }
  if (!url.hostname || !url.port) throw new EgressError('invalid egress url: missing host/port');
  return url;
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new EgressError(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** Full socks5 CONNECT: dials the proxy, negotiates auth, requests host:port. */
export function socks5Dial(proxyUrl, { host, port }, timeoutMs) {
  return new Promise((resolve, reject) => {
    const username = proxyUrl.username ? decodeURIComponent(proxyUrl.username) : null;
    const password = proxyUrl.password ? decodeURIComponent(proxyUrl.password) : '';

    const socket = net.connect({ host: proxyUrl.hostname, port: Number(proxyUrl.port) });
    let buffer = Buffer.alloc(0);
    let stage = 'greeting'; // greeting -> auth -> connect -> done
    let settled = false;

    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new EgressError(`socks5: ${message}`));
    };
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners('data');
      socket.removeAllListeners('error');
      // H6: a window exists before tls.connect attaches its own error handler;
      // keep a catch-all so a proxy RST can never become an uncaught exception
      socket.on('error', () => socket.destroy());
      resolve(socket);
    };

    const timer = setTimeout(() => fail('handshake timeout'), timeoutMs);
    socket.once('error', (err) => fail(err.message));
    socket.on('data', (chunk) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      try { pump(); } catch (error) { fail(error.message); }
    });

    const sendGreeting = () => {
      socket.write(username
        ? Buffer.from([0x05, 0x02, 0x00, 0x02])
        : Buffer.from([0x05, 0x01, 0x00]));
    };
    const sendAuth = () => {
      const user = Buffer.from(username ?? '');
      const pass = Buffer.from(password);
      socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
    };
    const sendConnect = () => {
      const hostBuf = Buffer.from(host);
      const req = Buffer.alloc(7 + hostBuf.length);
      req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03; req[4] = hostBuf.length;
      hostBuf.copy(req, 5);
      req.writeUInt16BE(port, 5 + hostBuf.length);
      socket.write(req);
    };

    const pump = () => {
      if (stage === 'greeting') {
        if (buffer.length < 2) return;
        const [version, method] = [buffer[0], buffer[1]];
        if (version !== 0x05) return fail(`bad version ${version}`);
        buffer = buffer.subarray(2);
        if (method === 0x02 && username) {
          stage = 'auth';
          sendAuth();
        } else if (method === 0x00) {
          stage = 'connect';
          sendConnect();
        } else {
          return fail(`no acceptable auth method (0x${method.toString(16)})`);
        }
      }
      if (stage === 'auth') {
        if (buffer.length < 2) return;
        if (buffer[1] !== 0x00) return fail('auth rejected');
        buffer = buffer.subarray(2);
        stage = 'connect';
        sendConnect();
      }
      if (stage === 'connect') {
        if (buffer.length < 6) return; // smallest reply: ver,rep,rsv,atyp(1=ipv4),4B addr,2B port
        if (buffer[1] !== 0x00) {
          const codes = { 1: 'general failure', 2: 'not allowed', 3: 'network unreachable', 4: 'host unreachable', 5: 'connection refused', 6: 'ttl expired', 7: 'command not supported', 8: 'address type not supported' };
          return fail(codes[buffer[1]] ?? `reply 0x${buffer[1].toString(16)}`);
        }
        const atyp = buffer[3];
        let need;
        if (atyp === 0x01) need = 10;
        else if (atyp === 0x04) need = 22;
        else if (atyp === 0x03) {
          if (buffer.length < 5) return;
          need = 5 + buffer[4] + 2;
        } else return fail(`bad address type 0x${atyp.toString(16)}`);
        if (buffer.length < need) return;
        buffer = buffer.subarray(need);
        stage = 'done';
        if (buffer.length > 0) socket.unshift(buffer); // early tls bytes, if any
        done();
      }
    };

    socket.once('connect', sendGreeting);
  });
}

/** http(s) CONNECT tunnel to the proxy; resolves the raw tunnel socket. */
function httpConnect(proxyUrl, { host, port }, timeoutMs) {
  return new Promise((resolve, reject) => {
    const scheme = proxyUrl.protocol.replace(':', '');
    const proxyPort = Number(proxyUrl.port) || (scheme === 'https' ? 443 : 80);
    let socket = null;
    // M8: destroy the half-open socket when the whole dance times out
    const timer = setTimeout(() => {
      if (socket) socket.destroy();
      reject(new EgressError('http proxy: CONNECT timeout'));
    }, timeoutMs);
    const settle = (fn, value) => {
      clearTimeout(timer);
      fn(value);
    };
    const establish = (sock) => {
      const auth = proxyUrl.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password ?? '')}`).toString('base64')}\r\n`
        : '';
      sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
      let head = Buffer.alloc(0);
      const onData = (chunk) => {
        head = Buffer.concat([head, chunk]);
        const marker = head.indexOf('\r\n\r\n');
        if (marker === -1) return;
        sock.off('data', onData);
        sock.off('error', onError);
        const text = head.subarray(0, marker).toString('latin1');
        const statusLine = text.slice(0, text.indexOf('\r\n'));
        const code = Number(statusLine.split(' ')[1]);
        if (code !== 200) {
          sock.destroy();
          return settle(reject, new EgressError(`http proxy: CONNECT ${code}`));
        }
        const rest = head.subarray(marker + 4);
        if (rest.length > 0) sock.unshift(rest);
        settle(resolve, sock);
      };
      const onError = (err) => settle(reject, new EgressError(`http proxy: ${err.message}`));
      sock.on('data', onData);
      sock.once('error', onError);
    };
    const onError = (err) => settle(reject, new EgressError(`http proxy: ${err.message}`));
    const opts = { host: proxyUrl.hostname, port: proxyPort };
    socket = scheme === 'https'
      ? tls.connect({ ...opts, servername: proxyUrl.hostname }, () => establish(socket))
      : net.connect(opts, () => establish(socket));
    socket.once('error', onError);
  });
}

/**
 * Returns a socket for target host:port honoring the egress url.
 * egressUrl: null (direct) | socks5(h)://[user:pass@]h:p | http(s)://[user:pass@]h:p
 */
export async function egressConnect({ egressUrl, host, port, timeoutMs = 30_000 }) {
  if (!egressUrl) return net.connect({ host, port });
  const proxyUrl = parseProxyUrl(egressUrl);
  const scheme = proxyUrl.protocol.replace(':', '');
  if (scheme === 'socks5' || scheme === 'socks5h') {
    return withTimeout(socks5Dial(proxyUrl, { host, port }, timeoutMs), timeoutMs + 1_000, 'socks5: dial timeout');
  }
  return httpConnect(proxyUrl, { host, port }, timeoutMs);
}

/** tls.connect over the egress path; used as https.Agent createConnection. */
export async function egressTlsConnection({ egressUrl, host, port = 443, servername, timeoutMs = 30_000 }) {
  const raw = await egressConnect({ egressUrl, host, port, timeoutMs });
  return tls.connect({
    socket: raw,
    servername: servername ?? host,
    // native antigravity sends no ALPN extension: keep the wire shape aligned
    ALPNProtocols: [],
  });
}

/** https.Agent (or http.Agent for plaintext) routing all connections through egress. */
export function makeEgressAgent({ egressUrl, protocol = 'https:' }) {
  const opts = { keepAlive: true, maxSockets: 8 };
  if (!egressUrl) {
    return protocol === 'https:' ? new https.Agent(opts) : new http.Agent(opts);
  }
  const connect = (options, cb) => {
    // node Agent may set only `hostname` — never dial "undefined"
    const host = options.hostname ?? options.host;
    const dial = protocol === 'https:'
      ? egressTlsConnection({ egressUrl, host, port: options.port ?? 443, servername: options.servername ?? host })
      : egressConnect({ egressUrl, host, port: options.port ?? 80 });
    dial.then((socket) => cb(null, socket)).catch((err) => cb(err));
  };
  // NOTE: options-level createConnection is ignored by Agent (prototype method
  // wins), so a subclass override is required.
  class EgressAgent extends (protocol === 'https:' ? https.Agent : http.Agent) {
    createConnection(options, cb) {
      connect(options, cb);
    }
  }
  return new EgressAgent(opts);
}
