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
    // Register the trajectory (writeTrajectoryAcls) before each generate call, the way the
    // official CLI does. Off by default so a bare relay keeps its old one-POST shape; production
    // turns it on in config.json.
    trajectoryAcls: false,
    // report turns to play.googleapis.com/log like the CLI does (best effort)
    telemetry: false,
    // call fetchUserInfo / retrieveUserQuotaSummary / listExperiments once per account at start
    warmup: false,
    // Replace harness/vendor identity markers ("Nous Research", "Hermes", "Claude Code",
    // "Anthropic", …) in the system instruction before dispatch. Cloud Code answers an opaque
    // 429 to some of them; see rewrite/identity-scrub.js. `extra` appends deployment-specific
    // [from, to] pairs to the built-in list.
    identityScrub: { enabled: true, extra: [] },
    requestTimeoutMs: 120_000,
    // refresh the oauth access token 5 minutes before expiry
    eagerRefreshMs: 5 * 60 * 1000,
    // optional outbound proxy for ALL upstream traffic (hides the host IP):
    // url: 'socks5://127.0.0.1:1055' | 'http://user:pass@host:port' | null
    // per-account override: accounts: { '<email>': '<proxy-url>', '<filename>.json': '<proxy-url>' }
    // (matched by email or file BASENAME INCLUDING extension; unknown key = the global url)
    //
    // Once accounts are declared here every account must have its own exit: an account without one
    // fails closed as an egress failure instead of dialling from the host IP, and two accounts on
    // one lane are refused (the client keeps the first). With no egress configured at all the relay
    // is a plain local relay and the host IP is the exit.
    egress: { url: null },
  },

  apiKey: null, // set to require "Authorization: Bearer <key>" or "x-api-key: <key>" from clients

  // Last-resort relay when the whole antigravity account pool is exhausted
  // (all accounts 429/cooling/failing). Only fires for gemini-family models —
  // the target is a Vertex OpenAI-compatible endpoint, non-gemini ids would 400.
  //
  // Disabled by default: switching provider silently and downgrading the model tier (the target
  // cannot serve the -low/-medium/-high effort suffix) is a product decision, not a default. Turn
  // it on explicitly with `fallback.enabled: true` in config.json or
  // ANTIGRAVITY_PROXY_VERTEX_FALLBACK=<vertex-url> in the environment.
  fallback: {
    vertexUrl: 'http://127.0.0.1:18804/v1/chat/completions',
    enabled: false,
    timeoutMs: 120_000,
  },

  rotation: {
    // Legacy setting retained for config compatibility; scoped quota cooldowns are driven by the
    // upstream reset hint, not by this value.
    cooldownMs: 60_000,
    // A structured quota failure (QuotaFailure / QUOTA_EXHAUSTED / reset metadata) parks the
    // account+model until the upstream reset time. When the upstream gives no reset hint, this
    // window is used instead; 0 disables the default park (a reset hint still parks).
    quotaCooldownMs: 5 * 60 * 1000,
    // Optional pool-wide pause after the first 403 TOS_VIOLATION (ms). 0 keeps the block on the
    // offending credential only, like CLIProxyAPI's default `tos-pause-window: 0`.
    tosPauseMs: 0,
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

  // Persisted pool state: scoped quota parks and TOS credential blocks survive a restart.
  // 0600, local file only; the journal stays payload-free.
  state: {
    poolPath: '~/.antigravity-proxy/pool-state.json',
  },
};
