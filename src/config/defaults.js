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
    userAgent: (() => {
      // Official Antigravity CLI wire UA, measured from agy 1.3.3 on 17.10.2026
      // (system-vm, linux/arm64). The CLI reports its real host, so this relay
      // does the same instead of claiming the old Hub client's darwin/arm64.
      const version = process.env.AGY_CLI_VERSION || '1.3.3';
      const build = process.env.AGY_CLI_BUILD || '996823801';
      const osType = process.platform === 'darwin' ? 'darwin'
        : process.platform === 'win32' ? 'windows' : 'linux';
      const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
      return `antigravity/cli/${version} (aidev_client; os_type=${osType}; arch=${arch}; cl=${build}; auth_method=consumer)`;
    })(),
    requestTimeoutMs: 120_000,
    // refresh the oauth access token 5 minutes before expiry
    eagerRefreshMs: 5 * 60 * 1000,
    // optional outbound proxy for ALL upstream traffic (hides the host IP):
    // url: 'socks5://127.0.0.1:1055' | 'http://user:pass@host:port' | null
    // per-account override: accounts: { '<email>': '<proxy-url>', '<filename>.json': '<proxy-url>' }
    // (matched by email or file BASENAME INCLUDING extension; unknown key = silently global)
    egress: { url: null },
  },

  apiKey: null, // set to require "Authorization: Bearer <key>" or "x-api-key: <key>" from clients

  // Last-resort relay when the whole antigravity account pool is exhausted
  // (all accounts 429/cooling/failing). Only fires for gemini-family models —
  // the target is a Vertex OpenAI-compatible endpoint, non-gemini ids would 400.
  fallback: {
    vertexUrl: 'http://127.0.0.1:18804/v1/chat/completions',
    enabled: true,
    timeoutMs: 120_000,
  },

  rotation: {
    // after a 429 RESOURCE_EXHAUSTED the account cools down for this long (ms)
    cooldownMs: 60_000,
    // Total budget for one request, preparation through the last fallback (ms). Mari cuts a turn
    // at 120 s, so the default sits just under it; raise it for callers that wait longer. The
    // per-attempt ladder (rotation.attemptTimeoutsMs) only shortens attempts inside this budget.
    requestDeadlineMs: 110_000,
    // Flow-aware attempts (OpenAI SSE and the SSE collection of a non-stream request): how long an
    // attempt may go without its FIRST meaningful frame (text, thinking, tool call, refusal or an
    // explicit terminal), measured from the start of the attempt including preparation. Keepalives
    // and role-only deltas do not count. A missing or non-positive value falls back to the default.
    firstMeaningfulFrameTimeoutMs: 45_000,
    // ...and how long it may then go between meaningful frames. Neither timer extends the request
    // deadline or the explicit ladder, and the native generateContent lane has neither (no frames).
    idleTimeoutMs: 30_000,
  },
};
