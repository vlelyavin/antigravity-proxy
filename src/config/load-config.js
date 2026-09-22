import { DEFAULTS } from './defaults.js';
import fs from 'node:fs';
import path from 'node:path';

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

import os from 'node:os';

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function loadConfig({ configPath = null, env = process.env } = {}) {
  let fileConfig = {};
  const candidates = [
    configPath,
    env.ANTIGRAVITY_PROXY_CONFIG,
    path.join(process.cwd(), 'config.json'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const p = expandHome(candidate);
    if (fs.existsSync(p)) {
      fileConfig = JSON.parse(fs.readFileSync(p, 'utf8'));
      break;
    }
  }

  const config = deepMerge(DEFAULTS, fileConfig);

  // env overrides
  if (env.ANTIGRAVITY_PROXY_PORT) config.listen.port = Number(env.ANTIGRAVITY_PROXY_PORT);
  if (env.ANTIGRAVITY_PROXY_HOST) config.listen.host = env.ANTIGRAVITY_PROXY_HOST;
  if (env.ANTIGRAVITY_PROXY_API_KEY) config.apiKey = env.ANTIGRAVITY_PROXY_API_KEY;
  if (env.ANTIGRAVITY_PROXY_LOG_LEVEL) config.logLevel = env.ANTIGRAVITY_PROXY_LOG_LEVEL;
  if (env.ANTIGRAVITY_PROXY_UPSTREAM) config.upstream.baseUrl = env.ANTIGRAVITY_PROXY_UPSTREAM;
  if (env.ANTIGRAVITY_PROXY_VERTEX_FALLBACK === 'off' || env.ANTIGRAVITY_PROXY_VERTEX_FALLBACK === 'none') config.fallback.enabled = false;
  else if (env.ANTIGRAVITY_PROXY_VERTEX_FALLBACK) config.fallback.vertexUrl = env.ANTIGRAVITY_PROXY_VERTEX_FALLBACK;

  if (!Number.isInteger(config.listen.port) || config.listen.port < 0 || config.listen.port > 65535) {
    throw new Error(`invalid listen.port: ${config.listen.port}`);
  }
  return config;
}
