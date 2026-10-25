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
│    ├─ decision loop (sticky first)        │
│    ├─ request-local tried vs shared state │
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
│    ├─ generation-aware token/project cache│
│    ├─ POST v1internal:generateContent     │
│    └─ POST v1internal:streamGenerateContent?alt=sse
│         │                                 │
│  upstream/failure.js + rotation-policy.js │
│    structured failure -> pure decision    │
│  upstream/account-pool.js                 │
│    scoped restrictions + recovery probes  │
│         │                                 │
│  credentials/credential-store.js          │
│    re-reads token files every request     │
└───────────────────────────────────────────┘
        │  Bearer <oauth access token>
        ▼
https://daily-cloudcode-pa.googleapis.com/v1internal:*
```

## accounts and failure classes

the relay keeps two kinds of state apart. `tried` belongs to one request: it only avoids repeating an
account inside that request. shared state is a map of **scoped** restrictions written only by a
proven decision:

- `account` - proven account-wide restriction;
- `account_model` - one account and one catalogue model;
- `project` - one resolved project resource (shared by every account that resolves to it);
- `egress` - one effective egress identity. two authenticated proxy sessions can share host:port, so
  the internal key is the whole configured URL (secret-bearing); only its `egress-<hash>` alias ever
  appears in a journal or status;
- `credential` - a revoked material generation. the key is the refresh token's hash, never logged.
  it stays blocked until the refresh token at that path changes or an operator retries; an access
  token refresh is a new token version and keeps the same generation.

selection is sticky-first, not round-robin: `pool.select` returns the first account that is eligible
for the requested model, project and egress and was not tried by this request. one account serving a
run of requests keeps gemini's per-account implicit prompt cache warm.

`src/upstream/failure.js` is the one failure contract. only trusted structured fields classify:
observed HTTP status, the exact `error.status` enum of a parsed JSON error body, an exact top-level
OAuth error code, or a local observation (parse failure, egress stage, deadline). messages are never
inspected - not for `invalid_grant`, not for `quota`. `publicStatus` is separate from
`observedStatus`; an upstream 401 maps to a caller 502, never to the caller's API-key 401.

`src/upstream/rotation-policy.js` is pure: failure in, decision out. the matrix:

| observation | request action | shared state |
|---|---|---|
| client cancellation, total deadline | stop | none |
| invalid request/config, local parser defect | stop with explicit cause | none |
| refusal or documented terminal | return | none |
| truncated/malformed/unknown terminal | alternate | none |
| generic 5xx, unknown network/body failure | alternate | none |
| bare 429 / `RESOURCE_EXHAUSTED` | request-local alternate | none: quota owner unknown |
| generation 401 | refresh once, retry this credential at most once | none |
| second 401 | request-local avoid `auth_rejected_after_refresh` | none |
| exact token-endpoint `invalid_grant` | alternate | block that credential generation |
| OAuth timeout/429/5xx/malformed | alternate with the refresh class | none |
| proven egress dial/CONNECT failure | alternate on another pinned egress | that egress only |
| ambiguous 403/permission/model | alternate or explicit failure | none |

unknown, protocol and transient failures share one request-local failed-account budget of two. for N
credentials loaded at request entry the dispatch budget admits at most 2N generation POSTs, 2N OAuth
POSTs and N project POSTs; one credential gets at most two generation POSTs, shared by the connection
retry and the forced-auth retry. a caller joining an in-flight refresh records a join, not a POST.
the request deadline always wins.

an expired restriction admits exactly one real bounded attempt as a recovery probe. the lease is
held from selection through the attempt and released on success, failure, cancellation and timeout.
a successful probe clears only restriction records whose evidence revision has not moved; a late
success cannot erase a newer cooldown, and a late failure for an old generation is skipped after the
handler re-reads the credential material. expiry or release without success is not recovery.

inferred availability is process-local: construction emits `pool.reset` with `persisted=false`, so a
restart is an explicit reset and never reported as verified recovery. durable provider state is a
separate requirement, not an implicit database.

pool exhaustion is typed. 429 is returned only when proven quota evidence explains every exclusion;
all-blocked credentials and egress gates answer 503, mixed/unknown histories answer an explicit 503
or the last real failure. `Retry-After` comes only from a recorded eligibility time or a real
upstream header. the model/account/project/provider quota vocabulary is intentionally inactive: no
genuine AGY scoped quota metadata was established, so the proven-evidence allowlist is empty and a
fixture with convenient fields cannot activate it.

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

## oauth and credential generations

- tokens come from the antigravity cli (`agy`) or gemini cli files; both
  refresh through `oauth2.googleapis.com/token` with the public embedded
  client id/secret of the antigravity cli.
- the store re-reads the files per request, so re-logging in elsewhere
  refreshes the relay without a restart. `lastGood` survives a partial rewrite.
- the material generation is a private hash of the refresh token. access-token
  and project caches are keyed by it; a replaced refresh token at the same path
  stops using the old cached token and makes a revoked generation selectable
  again. normal refresh increments a token version but not the generation.
- shared refresh singleflight is keyed by account+generation. a stale finally
  cannot delete a newer entry, and a late old-generation result cannot replace
  a newer cached token.
- only an exact top-level `error: "invalid_grant"` from the token endpoint is
  revocation. network, 429, 5xx and malformed token responses keep their own
  transient class and never block the credential.

## project id

some token files carry `project_id`; the code-assist onboarding project
(`aicode-consumers...`) is what the backend bills quota against. files without
one still work — the relay resolves the project with one `loadCodeAssist` probe
per credential generation and caches it. the resolved project is rechecked
against project gates immediately before generation dispatch: an initially
unknown project does not prove that the next account uses an independent
resource, and the raw project id never enters a journal (its status alias is
`project-<hash>`).

## correlation and response metadata

one strict UUID is generated per incoming call (a caller `x-request-id` is
accepted only in strict UUID form; arbitrary text is replaced and never
journaled). every response carries `x-agy-request-id`, `x-agy-route`
(`agy|vertex_fallback`), `x-agy-attempts` (account attempts) and
`x-agy-policy`; failures may add a fixed `x-agy-reason`. on an SSE response the
count is the value known at header commit, so it is not a claim about later
work. detailed attempt decisions remain in the journal under the same UUID:
requested model, catalogue-validated outbound model and provider-reported model
are separate fields, and `modelReported` is null because the AGY wire response
does not identify the served model. `GET /health` keeps its existing fields and
adds `liveness` plus an eligibility block with safe scoped state; readable
credentials are not the same as eligible accounts.
