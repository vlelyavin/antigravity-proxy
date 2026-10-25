/**
 * One-line-per-event journal writer. Callers pass curated fields only: the log is payload-free by
 * contract (no prompt text, tokens, upstream bodies, emails or credential paths), so there is no
 * redaction layer here - a field that would need redacting does not belong in the call site.
 * `sink` exists so tests can assert on the exact journal lines the process would write.
 */
export function createLogger(level = 'info', sink = process.stdout) {
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  const threshold = order[level] ?? 20;
  const emit = (lvl, msg, fields = {}) => {
    if (order[lvl] < threshold) return;
    const ts = new Date().toISOString();
    const rest = Object.entries(fields).map(([k, v]) => ` ${k}=${JSON.stringify(v)}`).join('');
    sink.write(`${ts} ${lvl.toUpperCase().padEnd(5)} ${msg}${rest}\n`);
  };
  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}
