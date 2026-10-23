# Architecture

```
openai client (hermes / opencode / curl)
        │  POST /v1/chat/completions        (openai wire format)
        ▼
┌───────────────────────────────────────────┐
│ antigravity-proxy                         │
│                                           │
│  server/create-server.js                  │
│    ├─ /health        account status       │
│    ├─ /v1/models     static catalog       │
│    └─ /v1/chat/completions               │
│         │                                 │
│  server/handlers.js                       │
│    ├─ rotation loop (up to 3 accounts)    │
│    ├─ non-stream: json in/out             │
│    └─ stream: SSE in / SSE out            │
│         │                                 │
│  rewrite/openai-translate.js              │
│    openai messages ↔ cloud-code contents  │
│    tools ↔ functionDeclarations           │
│    tool_calls ↔ functionCall parts        │
│    images (data urls) ↔ inlineData        │
│         │                                 │
│  upstream/upstream-client.js              │
│    ├─ token refresh (5min eager)          │
│    ├─ POST v1internal:generateContent     │
│    └─ POST v1internal:streamGenerateContent?alt=sse
│         │                                 │
│  upstream/account-pool.js                 │
│    round-robin + 429 cooldown             │
│         │                                 │
│  credentials/credential-store.js          │
│    re-reads token files every request     │
└───────────────────────────────────────────┘
        │  Bearer <oauth access token>
        ▼
https://daily-cloudcode-pa.googleapis.com/v1internal:*
```

## Why the daily host

The production host (`cloudcode-pa.googleapis.com`) returns `429 RESOURCE_EXHAUSTED` for requests that do not come from an authentic Antigravity client, even when `retrieveUserQuota` shows remaining quota. In contrast, the `daily-` mirror (the endpoint used by the Antigravity IDE and CLIProxyAPI) accepts the exact same payload with a `200` response. Both hosts use identical authentication. The proxy defaults to the daily mirror, which can be overridden via `ANTIGRAVITY_PROXY_UPSTREAM`.

## The Antigravity wire shape (what the relay builds)

```json
{
  "model": "gemini-3.8-flash-high",
  "userAgent": "antigravity",
  "requestType": "agent",
  "project": "<cloudaicompanion project>",
  "requestId": "agent-<uuid>",
  "request": {
    "contents": [{ "role": "user", "parts": [{ "text": "..." }] }],
    "generationConfig": { "maxOutputTokens": 1024 },
    "sessionId": "-<19-digit>"
  }
}
```

- The `userAgent: "antigravity"` property and the `User-Agent: antigravity/hub/<ver> ...` header route the request to the proper backend lane. A GeminiCLI user agent sent to this endpoint fails with `403 no valid license`.
- Thinking models consume `maxOutputTokens` on internal reasoning. An insufficient budget leads to `finishReason: MAX_TOKENS` with an empty response content; size token budgets accordingly.

## OAuth

- Tokens are loaded from Antigravity CLI (`agy`) or Gemini CLI credential files. Both refresh via `oauth2.googleapis.com/token` using the public client ID and secret embedded in the Antigravity CLI.
- The credential store re-reads files on every request, so re-authenticating in another terminal updates the relay without requiring a restart.
- Access tokens are cached in memory and proactively refreshed 5 minutes before expiration.

## Project ID

Some token files include a `project_id`. Quota usage is billed against the Code Assist onboarding project (`aicode-consumers...`). Files without this field continue to work normally, as the backend resolves the project from the account.
