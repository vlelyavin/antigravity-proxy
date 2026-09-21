export const DEFAULTS = {
  listen: { host: '127.0.0.1', port: 8317 },
  logLevel: 'info',

  credentials: {
    // search order: first match wins; each file = one antigravity account
    searchPaths: [
      '~/.gemini/antigravity-cli/antigravity-oauth-token', // agy CLI
      '~/.gemini/oauth_creds.json',                        // gemini-cli
      '~/.antigravity-proxy/accounts/*.json',              // extra accounts (optional)
    ],
  },

  upstream: {
    // daily mirror is the host the antigravity clients actually use; the prod
    // host answers 429 RESOURCE_EXHAUSTED to non-antigravity-shaped traffic
    baseUrl: 'https://daily-cloudcode-pa.googleapis.com',
    apiVersion: 'v1internal',
    userAgent: 'antigravity/hub/2.9.1 darwin/arm64',
    requestTimeoutMs: 120_000,
    // refresh the oauth access token 5 minutes before expiry
    eagerRefreshMs: 5 * 60 * 1000,
    // optional outbound proxy for ALL upstream traffic (hides the host IP):
    // url: 'socks5://127.0.0.1:1055' | 'http://user:pass@host:port' | null
    egress: { url: null },
  },

  apiKey: null, // set to require "Authorization: Bearer <key>" or "x-api-key: <key>" from clients

  rotation: {
    // after a 429 RESOURCE_EXHAUSTED the account cools down for this long (ms)
    cooldownMs: 60_000,
  },
};
