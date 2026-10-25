import { errorCategory } from '../utils/error-category.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accountLabel } from '../utils/alias.js';

export class CredentialStoreError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'CredentialStoreError';
  }
}

/**
 * Private material identity of one credential: the refresh token is the durable secret, while the
 * access token rotates on every normal refresh. The value is never logged or exposed; it only keys
 * in-memory caches and revoked-generation blocks. Replacing the refresh token at the same path
 * produces a different generation, which is what makes the new credential selectable again.
 */
export function materialGeneration(refreshToken) {
  if (typeof refreshToken !== 'string' || refreshToken === '') return null;
  return createHash('sha256').update(refreshToken).digest('hex');
}

function expandHome(p, home = os.homedir()) {
  if (!p) return p;
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/**
 * Reads antigravity OAuth token files. Supported shapes:
 *  - agy:    { auth_method, token: { access_token, refresh_token, expiry }, email? }
 *  - gemini-cli: { access_token, refresh_token, expiry_date, scope, token_type }
 *  - plain:  { access_token, refresh_token, expires_at?, project_id? }
 * Every access to disk re-reads the file, so an external login refresh is picked
 * up without restarting the proxy (same behavior as claude-proxy).
 */
export class CredentialStore {
  constructor({ searchPaths = [], logger = console } = {}) {
    this.searchPaths = searchPaths;
    this.logger = logger;
    this.lastGood = new Map(); // file -> last successfully parsed account
  }

  locateFiles() {
    const found = [];
    for (const raw of this.searchPaths) {
      const p = expandHome(raw);
      if (p.includes('*')) {
        const dir = path.dirname(p);
        const pattern = path.basename(p);
        const regex = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]+') + '$');
        let entries = [];
        try { entries = fs.readdirSync(dir); } catch { continue; }
        for (const entry of entries.filter((e) => regex.test(e)).sort()) {
          found.push(path.join(dir, entry));
        }
      } else if (fs.existsSync(p)) {
        found.push(p);
      }
    }
    return found;
  }

  readAll() {
    const accounts = [];
    for (const file of this.locateFiles()) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const account = normalizeAccount(raw, file);
        if (account) {
          accounts.push(account);
          this.lastGood.set(file, account); // M6: survive partial writes
        }
      } catch (error) {
        // another process may be mid-rewrite of the token file: fall back to
        // the last known good snapshot for this file instead of dropping it
        const good = this.lastGood.get(file);
        if (good) {
          accounts.push(good);
          // a credential path is payload for the journal: only its stable label travels
          this.logger.warn('credentials.partial_write_fallback', { account: accountLabel(file) });
        } else {
          // a JSON.parse message can quote the token it choked on, so only the category travels
          this.logger.warn('credentials.unreadable', { account: accountLabel(file), reason: errorCategory(error) });
        }
      }
    }
    if (accounts.length === 0) {
      throw new CredentialStoreError(
        'no antigravity token files found. Log in with `agy` (Antigravity CLI) or `gemini` (Gemini CLI) first, ' +
        'or point ANTIGRAVITY_PROXY_CONFIG credentials.searchPaths at your token file.'
      );
    }
    return accounts;
  }
}

export function normalizeAccount(raw, file) {
  let accessToken, refreshToken, expiry, email = null, projectId = null;

  if (raw?.token?.access_token && raw?.token?.refresh_token) {
    // agy shape
    ({ access_token: accessToken, refresh_token: refreshToken } = raw.token);
    expiry = raw.token.expiry ? Date.parse(raw.token.expiry) : null;
    email = raw.email || raw.account || null;
    projectId = raw.project_id || raw.token.project_id || null;
  } else if (raw?.access_token && raw?.refresh_token) {
    accessToken = raw.access_token;
    refreshToken = raw.refresh_token;
    expiry = raw.expiry_date ?? raw.expires_at ?? null;
    if (typeof expiry === 'number' && expiry < 10_000_000_000_000) expiry = null; // garbage guard
    if (typeof expiry === 'string') expiry = Date.parse(expiry) || null;
    email = raw.email || null;
    projectId = raw.project_id || null;
  } else {
    return null;
  }

  // email can often be extracted from the id_token JWT payload
  if (!email && typeof raw.id_token === 'string') {
    try {
      const payload = JSON.parse(Buffer.from(raw.id_token.split('.')[1], 'base64url').toString('utf8'));
      email = payload.email || null;
    } catch { /* not a JWT */ }
  }

  return {
    id: file,
    email,
    projectId,
    accessToken,
    refreshToken,
    generation: materialGeneration(refreshToken), // private; never journaled
    expiry, // epoch ms or null
  };
}
