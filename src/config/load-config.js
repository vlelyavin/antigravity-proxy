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

/**
 * A full copy of the merged config. `deepMerge` shallow-copies every level it does not touch, so a
 * nested object (for example `fallback`, with no file-provided keys) would still be the module-level
 * DEFAULTS object - and any later override would edit the defaults for the rest of the process,
 * making "off by default" depend on which config happened to load first.
 */
function cloneConfig(value) {
  if (Array.isArray(value)) return value.map(cloneConfig);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cloneConfig(v)]));
  }
  return value;
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

  // fully detached from DEFAULTS: the env overrides below must never edit the shipped defaults
  const config = cloneConfig(deepMerge(DEFAULTS, fileConfig));

  // env overrides
  if (env.ANTIGRAVITY_PROXY_PORT) config.listen.port = Number(env.ANTIGRAVITY_PROXY_PORT);
  if (env.ANTIGRAVITY_PROXY_HOST) config.listen.host = env.ANTIGRAVITY_PROXY_HOST;
  if (env.ANTIGRAVITY_PROXY_API_KEY) config.apiKey = env.ANTIGRAVITY_PROXY_API_KEY;
  if (env.ANTIGRAVITY_PROXY_LOG_LEVEL) config.logLevel = env.ANTIGRAVITY_PROXY_LOG_LEVEL;
  if (env.ANTIGRAVITY_PROXY_UPSTREAM) config.upstream.baseUrl = env.ANTIGRAVITY_PROXY_UPSTREAM;
  // Vertex fallback is off unless something says otherwise: an off/none value keeps it off, a url
  // is an explicit "relay here" instruction (so it enables the relay it names), and a bare switch
  // (on/true/1) enables the configured vertexUrl. Nothing here can enable it by accident.
  const fallbackSwitch = env.ANTIGRAVITY_PROXY_VERTEX_FALLBACK;
  if (fallbackSwitch === 'off' || fallbackSwitch === 'none') {
    config.fallback.enabled = false;
  } else if (fallbackSwitch === 'on' || fallbackSwitch === 'true' || fallbackSwitch === '1') {
    config.fallback.enabled = true;
  } else if (fallbackSwitch) {
    config.fallback.vertexUrl = fallbackSwitch;
    config.fallback.enabled = true;
  }

  if (!Number.isInteger(config.listen.port) || config.listen.port < 0 || config.listen.port > 65535) {
    throw new Error(`invalid listen.port: ${config.listen.port}`);
  }
  return config;
}
