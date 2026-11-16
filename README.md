# antigravity-proxy

[README на русском](README.ru.md)

you have a google ai pro subscription. your tools want an openai endpoint. this sits in the middle: a local relay that pushes openai chat-completions through your antigravity / code-assist oauth, so hermes / opencode / anything-openai rides on the sub instead of a per-token bill.

## what it does

- reads your local antigravity/gemini oauth token from disk on every request — a fresh login elsewhere needs no restart
- translates openai `chat/completions` ↔ cloud code `generateContent` structurally, both directions, including tool calls and images
- streams: openai SSE out of the cloud-code SSE frames, and the native Gemini `:streamGenerateContent` lane passes the upstream frames through
- scrubs harness identity from the system instruction (`Nous Research`, `Hermes`, `Claude Code`, `Anthropic`, …) before dispatch: cloud code answers an opaque 429 to some of those markers
- structural quota evidence (a `QuotaFailure` / `QUOTA_EXHAUSTED` enum or a reset timestamp in `error.details[]`) parks that account+model until the upstream reset time instead of re-hitting it
- a `403 TOS_VIOLATION` / `UNSUPPORTED_CLIENT` parks the account until an operator clears it, and the turn moves to another account; scoped state survives a restart
- multi-account, sticky-first: the first eligible account serves a run of requests, and the rest are the overflow — drop N token files in and all of them are candidates
- evidence-scoped rotation: a bare 429 rotates inside the request without guessing a quota owner; only an exact token-endpoint `invalid_grant` blocks that credential generation, and a proven egress failure gates that egress only
- bounds a held-open socket: the wait for the first meaningful frame and the gap between frames
- optional api key so the port isn't a free-for-all on your lan
- zero npm dependencies. node stdlib, nothing else.

## what it is not

- not a google product, not affiliated with them
- not a hosted service — runs on your machine, your creds
- not a cred bundle — nothing private ships in this repo

## straight talk

it uses subscription oauth outside the official client. that's a gray zone in google's tos — same club as every code-assist proxy. hammer it and you can lose the subscription; the quota is per-user (~1500 req/day on ai pro), and one agentic prompt can burn several requests. your call.

## requirements

- node 20+ (no build step, no npm install)
- a local oauth token from one of:
  - **antigravity cli** (`agy`) → `~/.gemini/antigravity-cli/antigravity-oauth-token`
  - **gemini cli** (`npm i -g @google/gemini-cli && gemini`) → `~/.gemini/oauth_creds.json`
  - any file with `{access_token, refresh_token, project_id?}` placed under `~/.antigravity-proxy/accounts/*.json`

## run

```bash
git clone https://github.com/vlelyavin/antigravity-proxy.git
cd antigravity-proxy
node src/cli.js
```

listens on `127.0.0.1:8317`.

```bash
curl -sS http://127.0.0.1:8317/health
```

health lists every account it found and token expiry. then:

```bash
curl -sS http://127.0.0.1:8317/v1/chat/completions \
  -H 'content-type: application/json' \
  --data '{"model":"gemini-3.8-flash-high","messages":[{"role":"user","content":"reply with exactly: pong"}]}'
```

a `pong` means the whole path works.

the native gemini lane and the read-only quota snapshot:

```bash
curl -sS -X POST http://127.0.0.1:8317/v1beta/models/gemini-3.8-flash:generateContent \
  -H 'content-type: application/json' \
  --data '{"contents":[{"role":"user","parts":[{"text":"reply with exactly: pong"}]}]}'
curl -sS http://127.0.0.1:8317/v1/quota
```

`:streamGenerateContent` on the same path answers native Gemini SSE frames. `/v1/quota` returns the `retrieveUserQuotaSummary` answers collected by the start-up warm-up (`upstream.warmup: true`); it never makes a fresh upstream call and carries account aliases, not emails.

## wire it into tools

openai-compatible base url `http://127.0.0.1:8317/v1`, api key — whatever you set (or `none`).

opencode:

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "provider": {
    "antigravity": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:8317/v1", "apiKey": "none" },
      "models": {
        "gemini-3.8-flash-high": { "limit": { "context": 1048576, "output": 65536 } },
        "gemini-3.1-pro-high": { "limit": { "context": 1048576, "output": 65536 } }
      }
    }
  }
}
```

hermes / any openai sdk: `base_url=http://127.0.0.1:8317/v1`, `api_key=none`, model ids from `GET /v1/models`.

## models

`gemini-3.8-flash-{low,medium,high,tiered}`, `gemini-4-{argon,hydrogen,carbon}-*`, `gemini-3-flash`, `gemini-3.1-flash-image`, `gemini-3.1/3.5-flash-lite`, `gemini-3.7/3.6-flash-*`, `gemini-3.1-pro-{low,high}`, `claude-sonnet-5-5-high`, `claude-opus-5-5-high`. the list lives in `src/rewrite/models.js` — extend it when google ships more.

google removes Claude Sonnet/Opus 4.6 and GPT-OSS-120B from antigravity on **2026-11-18**; the catalog carries their replacements instead. plan availability is per account: gemini 4 carbon, 3.7/3.6 flash and 3.1 pro are enterprise-only, and gemini 4 argon plus claude 5.5 need a paid (non-trial) AI Pro or Ultra plan.

## multi-account

put extra token files under `~/.antigravity-proxy/accounts/*.json` (shape: `{access_token, refresh_token, project_id?, email?}`). accounts are sticky-first, not round-robin: the first eligible account in file order serves every request. a run of requests on one account keeps gemini's implicit prompt cache warm, which round-robin split in half. 2-3 accounts per residential exit ip is the sane ceiling — more looks like a farm, and google farms get recaptcha'd.

two kinds of state stay separate:

- **request-local**: the accounts this one request already tried. it never changes shared health.
- **shared and scoped**: a proven restriction on exactly one account, account+model, project resource or egress identity. an unknown failure never widens into account state.

### egress: one exit per account, fail closed

`upstream.egress.accounts` maps an account (email, else the token file's basename including `.json`) to its own proxy url, so every account reaches google from its own ip. the rules are checked at start-up and again on every credential load, and they refuse an account rather than leak the host ip:

- **no exit, no traffic.** once the deployment declares any exit, an account that resolves to none is refused (`egress_unavailable`, scope `egress`, no credential penalty) before oauth, project resolution or generation runs. a deployment that declares no egress at all is the plain local relay and uses the host connection.
- **one exit, one account.** the first account of a lane keeps it; a later account resolving to the same url is refused (`egress_invalid_config`) and the journal carries one `egress.duplicate` error line naming both aliases and the `egress-<hash>` lane. several accounts inheriting one global `upstream.egress.url` share that exit and are refused the same way - give them per-account lanes instead. the relay keeps serving the accounts that do have their own exit: the mistake is per lane, never fatal to the process.
- two authenticated sessions on one host:port are different urls, so they are different exits and never collide.

a refused account is journalled once per transition (`egress.duplicate` / `egress.missing`), not once per request; emails, token paths and proxy urls never reach the line.

the failure policy:

| observation | request action | shared state |
|---|---|---|
| caller cancellation or total deadline | stop; no new work | none |
| invalid request/config, local parser defect | stop with the explicit cause | none |
| refusal or documented terminal (including `STOP`, `MAX_TOKENS`, safety) | return it | none |
| truncated/malformed/unknown terminal | bounded alternate | none |
| generic 5xx, unknown network/body failure | bounded alternate | none |
| bare 429 / `RESOURCE_EXHAUSTED` with no scoped evidence | request-local alternate only | none: the quota owner is unknown |
| structured quota: `QuotaFailure` / `QUOTA_EXHAUSTED` / a reset timestamp in `error.details[]` | alternate; the quota owner is known | that account+model is parked until the upstream reset time, or `rotation.quotaCooldownMs` when the answer has no reset hint |
| `403 TOS_VIOLATION` / `UNSUPPORTED_CLIENT` / `POLICY_VIOLATION` enum | alternate; never a rate limit, never a refresh | that account is blocked until an operator clears the pool state; `rotation.tosPauseMs` pauses the whole pool too |
| generation 401 / `UNAUTHENTICATED` | refresh once, retry this credential at most once; a second 401 avoids it for this request as `auth_rejected_after_refresh` | none |
| exact structured token-endpoint `invalid_grant` | alternate | that material credential generation is blocked until the refresh token changes or an operator retries |
| OAuth timeout/429/5xx/malformed | bounded alternate with the refresh failure class | none |
| proven egress dial/CONNECT failure | alternate on another pinned egress | that egress only; never a direct fallback |
| account with no exit, or a lane another account holds | alternate on an account that has its own exit; never a direct dial | none: a configuration mistake is not the credential's health |
| ambiguous 403/permission/model error | bounded alternate or explicit failure | none |

only structured evidence from `error.details[]` may cool an account/model: a `QuotaFailure`/`QUOTA_EXHAUSTED` enum, a TOS enum, or a reset timestamp. the free-text `message` is never inspected, and a bare 429 never widens into shared state.

unknown, protocol and transient failures share one request-local failed-account budget of **two**. for N credentials loaded at request entry the relay may issue at most **2N generation POSTs**, **2N OAuth token POSTs** and **N project-resolution POSTs**; one credential gets at most two generation POSTs, and the connection retry and the forced-auth retry share that allowance. a caller joining an in-flight shared refresh records a join, not another POST. the common deadline always wins. a transport retry may repeat a POST already received by the provider; it is counted as another potentially metered dispatch. an observed HTTP response never enters the connection retry.

a restriction that expires admits exactly **one** real bounded attempt as a recovery probe. the lease lasts through that attempt and is released on success, failure, cancellation and timeout; expiry or release is not recovery. a successful probe clears only state whose evidence revision has not moved - a late success cannot erase a newer cooldown. a late failure for an old credential generation cannot disable a replaced one, and a normal access-token refresh is a new token version, not a material replacement. scoped state (quota parks, TOS blocks, credential blocks) is written to `state.poolPath` (mode 0600) and restored on start-up; a restart emits `pool.reset` with the restored count, and expired quota parks are dropped at load time. a TOS block has no timer by design - clear it explicitly:

```bash
node src/cli.js --clear-pool   # removes the persisted scoped state, then start the service again
```

every request has one total budget, `rotation.requestDeadlineMs` (default 110 s): preparation, all account attempts, the stream collection and the vertex fallback share it, and no frame or retry resets it. the default sits just under mari's 120 s turn - raise it for callers that legitimately wait longer. a spent budget answers 504 and penalizes no account: the accounts were not the problem.

a client that cannot wait out a hung upstream sends `x-attempt-timeouts-ms: 45000,30000` (non-stream only): the first account gets min(45 s, what is left of the budget), the next one min(30 s, the rest, the last value repeats), then the vertex fallback answers with the remainder. no header - no per-attempt cut, only the total budget. mari sends it; hermes and opencode don't.

two flow timers cut an attempt that holds its socket open without progress: `rotation.firstMeaningfulFrameTimeoutMs` (default 45 s) waits for the first meaningful frame from the start of the attempt - preparation included - and `rotation.idleTimeoutMs` (default 30 s) bounds the gap between meaningful frames after that. a meaningful frame is text, thinking, a tool call or signature (including signature-only parts), a refusal or an explicit terminal; keepalive frames and role-only deltas reset neither timer. neither timer extends the total budget or the ladder. the cut rotates to the next account only while nothing has been written to the caller: once the client stream has started, the same cut ends that stream with an error frame and no other account's output is mixed into it. a committed stream still classifies independently proven health evidence; it just never retries.

terminal outcome and the native lane: a generation ends successfully only with a documented finish reason (`STOP` -> `stop`, `MAX_TOKENS` -> `length`, the safety family -> `content_filter`) or a prompt-level refusal. `MALFORMED_FUNCTION_CALL`, `LANGUAGE`, `OTHER`, an unspecified, malformed or unknown reason is a 502 protocol failure, never a fabricated `stop`; so is a stream that ends without a terminal frame - for a client stream that means an error frame plus `[DONE]`, and the request is journaled as failed. the native buffered `generateContent` lane applies the same explicit-error and terminal validation (an embedded 429 or a candidate without a terminal is not a 200), while a `promptFeedback` refusal remains a valid successful outcome. tool signatures and refusals cross unchanged.

pool exhaustion describes what actually happened. a 429 is returned only when proven quota evidence explains every exclusion; all-blocked credentials or egress gates answer 503, and mixed/unknown histories answer an explicit 503 or the last real failure instead of an invented 429. `Retry-After` is exposed only from a recorded eligibility time or a real upstream header, never from a local cooldown constant.

upstream credential401 and ambiguous403 map to caller502; caller API-key authentication stays401. embedded errors retain the actual HTTP status in the journal (for example observed200/public429), and caller errors use fixed text plus a correlation reference.

`GET /health` keeps its existing fields and adds `liveness` (can credentials be read) and `eligibility` (scoped restrictions, expiry, safe reason, active recovery probes, aliases only). readable credentials are not the same as usable eligibility.

## journal and correlation

every line is payload-free by contract: no prompt or completion text, no upstream body, no refusal text, no token, no email, no credential path, no project id, no proxy credentials. accounts appear as a stable alias - `acct-` plus eight hex characters of the sha256 of their credential path - so lines still correlate across restarts. egress appears as `egress-<hash>`; a project resource as `project-<hash>`. a refusal is a boolean (`blocked=true`).

one strict UUID identifies one incoming call. a caller `x-request-id` is accepted only when it is a well-formed UUID; arbitrary caller text is replaced by a generated UUID and never journaled. every model-call response - chat or native, success or error, SSE or buffered - carries:

| header | value |
|---|---|
| `x-agy-request-id` | the call's UUID |
| `x-agy-route` | `agy` or `vertex_fallback` |
| `x-agy-attempts` | account attempts so far (nonnegative decimal) |
| `x-agy-policy` | fixed policy version (`agy-rotator-1`) |
| `x-agy-reason` | fixed safe enum on failures, when known |

on a stream the attempt count is the value known at header commit (normally one, higher after a pre-header retry); no later attempt is implied. detailed decisions stay in the journal joined by the same UUID:

- `attempt.start requestId= attempt= account= stream= native= route= modelRequested= egress= policyVersion=` - one per account attempt.
- `attempt.timing requestId= attempt= account= outcome= status= observedStatus= reason= failureReason= failureOrigin= failurePhase= failureScope= failureEvidence= decision= decisionReason= sharedEffect= sharedScope= retry= stopReason= modelRequested= modelOutbound= modelReported= egress= generationPost= oauthPost= projectPost= prepMs= firstFrameMs= totalMs=` - one per attempt. `reason` keeps the legacy `category:status` string; the `failure*` fields carry the structured contract. `modelRequested`/`modelOutbound`/`modelReported` are separate facts from the catalogue-validated binding; `modelReported` is `null` because the AGY wire response does not identify the served model.
- `request.timing requestId= outcome= status= attempts= generationPosts= oauthPosts= projectPosts= refreshJoins= maxGenerationPosts= reason= totalMs= deadlineMs= route= policyVersion= stopReason= exhausted=` - one per request; `outcome` is `ok`, `failed`, `deadline`, `client_abort` or `vertex_fallback`. `exhausted` carries the actual selection counts, or `null`.
- `pool.restriction effect= scope= account= resource= until= reason= evidence= policyVersion=` and `pool.recovered scope= account= resource=` - every proven shared-state mutation and every probe recovery.
- `pool.reset persisted=false reason=process_start` - inferred availability is process-local; a restart clears it explicitly (not a recovery claim).
- `rotation.stall kind=first_frame_timeout|idle_timeout timeoutMs= rotatable=` - a flow cut, and whether another account could still answer.
- `chat.collect_failed requestId= account= endClass= frameCount= candidateCount= textFrames= reasoningFrames= toolFrames= signatureOnlyFrames= terminalSeen= wrappedError=` - one bounded line per rejected non-stream collection. `endClass=clean` means normal EOF followed by validation rejection; `error` means the body failed before EOF; `abort` means cancellation or a timeout/deadline. fixed counters and enums only.
- `stream.failed requestId= model= account= reason= failure*=` for a client stream that ended badly (the error frame already went out).
- `credentials.loaded accounts=[acct-...] projects=[set|missing] egress=[scheme//host:port]` - no emails, no token paths.

the `/health` endpoint still lists account emails: it is an operator tool, not the journal. the new eligibility block adds no identity or secret.

## systemd

```bash
sudo ./scripts/install-systemd.sh
```

one command — writes the unit, enables, starts. manual path in `docs/systemd.md`.

## vertex fallback: off by default

the relay can hand an exhausted pool to a local Vertex OpenAI-compatible endpoint, but that switches provider and drops the model tier (the effort suffixes `-low`/`-medium`/`-high` are stripped for it), so it is **disabled unless you say otherwise**. turn it on explicitly:

```json
{ "fallback": { "enabled": true, "vertexUrl": "http://127.0.0.1:18804/v1/chat/completions" } }
```

or with `ANTIGRAVITY_PROXY_VERTEX_FALLBACK=<vertex-url>` (a url enables the relay it names; `on`/`true`/`1` enable the configured url; `off`/`none` keep it off). when it answers, the response carries `x-agy-route: vertex_fallback` and the journal records `route: vertex_fallback`, so a switched request is auditable afterwards.

## structure

```
src/
  config/         defaults, env overrides, loader
  credentials/    token file lookup (agy / gemini-cli / raw), oauth refresh
  rewrite/        openai <-> cloud-code transforms, model catalog, identity scrub
  upstream/       cloud-code client, structured failure/policy, scoped pool
  server/         http surface: /health, /v1/models, /v1/quota,
                  /v1/chat/completions, /v1beta/models/{model}:{generateContent,streamGenerateContent}
test/             node:test suite, no network needed (one local cert fixture)
```

## security

- localhost only, unless you know exactly why not
- never commit token files or config.json
- set `apiKey` in config.json if anything besides your own machine can reach the port

## license

MIT
