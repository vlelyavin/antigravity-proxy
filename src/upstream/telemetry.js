// Telemetry: the CLI posts protobuf batches to play.googleapis.com/log on every turn. The relay
// sends a minimal but structurally identical event, so the backend sees the same "client reports
// its own turns" signal instead of a silent consumer. Best effort - a failure never costs a turn.
import https from 'node:https';

const LOG_URL = 'https://play.googleapis.com/log';
// log_source 16 is the value the CLI uses for this stream
const LOG_SOURCE = 16;

function varint(value) {
  const bytes = [];
  let rest = BigInt(value);
  while (rest > 0x7fn) {
    bytes.push(Number((rest & 0x7fn) | 0x80n));
    rest >>= 7n;
  }
  bytes.push(Number(rest));
  return Buffer.from(bytes);
}

const tag = (field, wire) => varint((field << 3) | wire);
const intField = (field, value) => Buffer.concat([tag(field, 0), varint(value)]);
const strField = (field, value) => {
  const buf = Buffer.from(String(value), 'utf8');
  return Buffer.concat([tag(field, 2), varint(buf.length), buf]);
};
const msgField = (field, buf) => Buffer.concat([tag(field, 2), varint(buf.length), buf]);

/**
 * One turn event. `outcome` is a short token (ok / error / rotate), `fields` extra key/value
 * pairs rendered as the repeated map entry the CLI uses.
 */
export function encodeTurnEvent({ version, osType, arch, outcome, fields = {} }) {
  const clientInfo = Buffer.concat([
    strField(1, 'antigravity'),
    strField(2, version),
    strField(3, osType),
    strField(4, arch),
    strField(9, 'cli'),
  ]);
  const entries = [msgField(2, Buffer.concat([strField(1, 'outcome'), strField(2, outcome)]))];
  for (const [key, value] of Object.entries(fields)) {
    entries.push(msgField(2, Buffer.concat([strField(1, key), strField(2, String(value))])));
  }
  const event = Buffer.concat([strField(1, 'relay_turn'), ...entries]);
  const logEvent = Buffer.concat([msgField(3, clientInfo), msgField(6, event)]);
  return Buffer.concat([intField(1, LOG_SOURCE), msgField(2, logEvent)]);
}

export class Telemetry {
  constructor({ enabled = false, userAgent = 'Go-http-client/1.1', version = '1.3.3', osType = 'linux', arch = 'arm64', logger = console } = {}) {
    Object.assign(this, { enabled, userAgent, version, osType, arch, logger });
  }

  /** Fire and forget: never awaited by the request path, never throws. */
  send(token, { outcome, fields } = {}) {
    if (!this.enabled || !token) return;
    const body = encodeTurnEvent({ version: this.version, osType: this.osType, arch: this.arch, outcome: outcome ?? 'ok', fields });
    const request = https.request(LOG_URL, {
      method: 'POST',
      headers: {
        'User-Agent': this.userAgent,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Accept-Encoding': 'gzip',
        'Content-Length': body.length,
      },
      timeout: 10_000,
    }, (res) => {
      res.resume();
      if (res.statusCode >= 400) this.logger.warn?.('telemetry.rejected', { status: res.statusCode });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', (error) => this.logger.warn?.('telemetry.failed', { reason: error.message }));
    request.end(body);
  }
}
