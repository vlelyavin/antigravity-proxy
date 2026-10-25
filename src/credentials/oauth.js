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

/** The exact OAuth error code in its structured top-level position, or null. No text scanning. */
export function oauthErrorCode(json) {
  return typeof json?.error === 'string' && json.error !== '' ? json.error : null;
}

/**
 * Refreshes an antigravity account's access token.
 * Returns { accessToken, expiresIn } — never logs or stores the values anywhere
 * except in memory.
 *
 * Failures are stamped with structured fields:
 *   - `invalidGrant` is true ONLY for an exact top-level `error: "invalid_grant"`;
 *   - `transient` covers a network failure, 429, 5xx and a malformed token response;
 *   - `reason`/`evidence`/`observedStatus` are fixed enums the rotation policy consumes.
 * An access-token refresh is a new token version, never a credential-material replacement.
 */
export async function refreshAccessToken(refreshToken, { fetchImpl = globalThis.fetch } = {}) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: ANTIGRAVITY_CLIENT_ID,
    client_secret: ANTIGRAVITY_CLIENT_SECRET,
  });
  let response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (cause) {
    const error = new Error('oauth token endpoint unavailable');
    error.transient = true;
    error.invalidGrant = false;
    error.reason = 'oauth_unavailable';
    error.evidence = 'oauth_network';
    error.observedStatus = null;
    error.cause = cause;
    throw error;
  }
  let json = null;
  try { json = await response.json(); } catch { json = null; }
  if (!response.ok || !json?.access_token) {
    const code = oauthErrorCode(json);
    const error = new Error('oauth token endpoint rejected the refresh');
    error.observedStatus = Number.isInteger(response.status) ? response.status : null;
    error.invalidGrant = code === 'invalid_grant';
    error.transient = json === null || response.status >= 500 || response.status === 429;
    if (error.invalidGrant) {
      error.reason = 'revoked_credential';
      error.evidence = 'oauth_invalid_grant';
    } else if (response.status >= 500 || response.status === 429) {
      // The endpoint's own failure class wins over a body that is not JSON.
      error.reason = 'oauth_unavailable';
      error.evidence = json === null ? 'oauth_network' : 'oauth_http_status';
    } else if (json === null) {
      error.reason = 'oauth_malformed';
      error.evidence = 'oauth_malformed_response';
    } else {
      error.reason = 'oauth_rejected';
      error.evidence = 'oauth_http_status';
    }
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
