export function createLogger(level = 'info') {
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  const threshold = order[level] ?? 20;
  const emit = (lvl, msg, fields = {}) => {
    if (order[lvl] < threshold) return;
    const ts = new Date().toISOString();
    const rest = Object.entries(fields).map(([k, v]) => ` ${k}=${JSON.stringify(v)}`).join('');
    process.stdout.write(`${ts} ${lvl.toUpperCase().padEnd(5)} ${msg}${rest}\n`);
  };
  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}
