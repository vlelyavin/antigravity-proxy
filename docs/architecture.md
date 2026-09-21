# architecture

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

## why the daily host

the prod host (`cloudcode-pa.googleapis.com`) answers `429 RESOURCE_EXHAUSTED`
to request shapes that don't come from a real antigravity client, even when
`retrieveUserQuota` shows full quota remaining. the `daily-` mirror (the host
the antigravity IDE and CLIProxyAPI actually use) accepts the same shape with
`200`. both hosts accept identical auth; the mirror is the default here and
`ANTIGRAVITY_PROXY_UPSTREAM` can override it.

## the antigravity wire shape (what the relay builds)

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

- `userAgent: "antigravity"` + `User-Agent: antigravity/hub/<ver> ...` header
  are what select the lane. a GeminiCLI user-agent on the same endpoint gets
  `403 no valid license`.
- thinking models burn `maxOutputTokens` on thoughts: a tiny budget yields
  `finishReason: MAX_TOKENS` with empty content. size budgets accordingly.

## oauth

- tokens come from the antigravity cli (`agy`) or gemini cli files; both
  refresh through `oauth2.googleapis.com/token` with the public embedded
  client id/secret of the antigravity cli.
- the store re-reads the files per request, so re-logging in elsewhere
  refreshes the relay without a restart.
- access tokens are cached in memory and refreshed 5 minutes before expiry.

## project id

some token files carry `project_id`; the code-assist onboarding project
(`aicode-consumers...`) is what the backend bills quota against. files without
one still work — the backend resolves the project from the account.
