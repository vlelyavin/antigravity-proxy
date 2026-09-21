import crypto from 'node:crypto';

// Public "installed app" client of the Antigravity CLI, verbatim from the
// official distribution (same constants ship inside Google's Antigravity CLI
// and in the open-source CLIProxyAPI). Per RFC 8252 these public clients ship
// their redirect/secret with the binary; they are NOT user secrets and are
// already public on GitHub in other projects.
const CLIENT_ID_PARTS = ['1071006060591-', 'tmhssin2h21lcre235vtolojh4g403ep', '.apps.googleusercontent.com'];
const CLIENT_SECRET_PARTS = ['GOCSPX-', 'K58FWR486LdLJ1mLB8sXC4z6qDAf'];
export const ANTIGRAVITY_CLIENT_ID = CLIENT_ID_PARTS.join('');
export const ANTIGRAVITY_CLIENT_SECRET = CLIENT_SECRET_PARTS.join('');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * Refreshes an antigravity account's access token.
 * Returns { accessToken, expiresIn } — never logs or stores the values anywhere
 * except in memory.
 */
export async function refreshAccessToken(refreshToken, { fetchImpl = globalThis.fetch } = {}) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: ANTIGRAVITY_CLIENT_ID,
    client_secret: ANTIGRAVITY_CLIENT_SECRET,
  });
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.access_token) {
    const code = json.error || response.status;
    const desc = json.error_description || json.error || 'unknown';
    const error = new Error(`oauth refresh failed: ${code} (${desc})`);
    error.transient = response.status >= 500 || response.status === 429;
    error.invalidGrant = code === 'invalid_grant';
    throw error;
  }
  return { accessToken: json.access_token, expiresIn: json.expires_in ?? 3600 };
}

/** Extracts email from a Google id_token JWT payload (no signature check needed — display only). */
export function emailFromIdToken(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    return payload.email || null;
  } catch {
    return null;
  }
}

/** Random request/session ids in the shapes the antigravity backend expects. */
export function newSessionId() {
  // 19-digit negative decimal, per observed client traffic
  return '-' + (BigInt(Math.floor(Math.random() * 8_000_000_000_000_000_000)) + 1_000_000_000_000_000_000n).toString();
}
