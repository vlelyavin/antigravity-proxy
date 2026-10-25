# antigravity-proxy

[README на русском](README.ru.md)

you have a google ai pro subscription. your tools want an openai endpoint. this sits in the middle: a local relay that pushes openai chat-completions through your antigravity / code-assist oauth, so hermes / opencode / anything-openai rides on the sub instead of a per-token bill.

## what it does

- reads your local antigravity/gemini oauth token from disk on every request — a fresh login elsewhere needs no restart
- translates openai `chat/completions` ↔ cloud code `generateContent` structurally, both directions, including tool calls and images
- streams: openai SSE out of the cloud-code SSE frames
- multi-account round-robin with 429 cooldown — drop N token files in and it rotates
- retries 5xx/network with backoff; quota errors rotate accounts instead of failing the request
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

`gemini-3.8-flash-{low,medium,high}`, `gemini-3.7/3.6-flash-*`, `gemini-3-flash`, `gemini-3.1-pro-{low,high}`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`. the list lives in `src/rewrite/models.js` — extend it when google ships more.

## multi-account

put extra token files under `~/.antigravity-proxy/accounts/*.json` (shape: `{access_token, refresh_token, project_id?, email?}`). round-robin picks the next healthy account; a 429 puts that account on cooldown and retries the next. 2-3 accounts per residential exit ip is the sane ceiling — more looks like a farm, and google farms get recaptcha'd.

every request has one total budget, `rotation.requestDeadlineMs` (default 110 s): preparation, all account attempts, the stream collection and the vertex fallback share it, and no frame or retry resets it. the default sits just under mari's 120 s turn - raise it for callers that legitimately wait longer. a spent budget answers 504 and cools no account: the accounts were not the problem.

a client that cannot wait out a hung upstream sends `x-attempt-timeouts-ms: 45000,30000` (non-stream only): the first account gets min(45 s, what is left of the budget), the next one min(30 s, the rest, the last value repeats), then the vertex fallback answers with the remainder. no header - no per-attempt cut, only the total budget. mari sends it; hermes and opencode don't.

two flow timers cut an attempt that holds its socket open without progress: `rotation.firstMeaningfulFrameTimeoutMs` (default 45 s) waits for the first meaningful frame from the start of the attempt - preparation included - and `rotation.idleTimeoutMs` (default 30 s) bounds the gap between meaningful frames after that. a meaningful frame is text, thinking, a tool call or signature (including signature-only parts), a refusal or an explicit terminal; keepalive frames and role-only deltas reset neither timer. neither timer extends the total budget or the ladder. the cut rotates to the next account only while nothing has been written to the caller: once the client stream has started, the same cut ends that stream with an error frame and no other account's output is mixed into it.

terminal outcome: a generation ends successfully only with a documented finish reason (`STOP` -> `stop`, `MAX_TOKENS` -> `length`, the safety family -> `content_filter`) or a prompt-level refusal. `MALFORMED_FUNCTION_CALL`, `LANGUAGE`, `OTHER`, an unspecified, malformed or unknown reason is a 502 protocol failure, never a fabricated `stop`; so is a stream that ends without a terminal frame - for a client stream that means an error frame plus `[DONE]`, and the request is journaled as failed. tool signatures and refusals cross unchanged.

the native `generateContent` lane stays buffered: it has no frames to measure, so it keeps only the ladder and the total budget and the flow timers deliberately do not apply to it.

## journal

every line is payload-free by contract: no prompt or completion text, no upstream body, no refusal text, no token, no email, no credential path, no project id, no proxy credentials. accounts appear as a stable alias - `acct-` plus eight hex characters of the sha256 of their credential path - so lines still correlate across restarts; a refusal is a boolean (`blocked=true`), failures are a category (`reason="quota:429"`, `"client_disconnected"`, `"first_frame_timeout"`).

- `attempt.timing requestId= attempt= account= stream= outcome= status= reason= prepMs= firstFrameMs= totalMs=` - one per account attempt. `firstFrameMs` is the wait for the first *meaningful* frame, so keepalive-only attempts report `null`.
- `request.timing requestId= outcome= status= attempts= reason= totalMs= deadlineMs=` - one per request; `outcome` is `ok`, `failed`, `deadline`, `client_abort` or `vertex_fallback`.
- `rotation.stall kind= first_frame_timeout|idle_timeout timeoutMs= rotatable=` - a flow cut, and whether another account could still answer.
- `stream.failed reason=` for a client stream that ended badly (the error frame already went out).
- `credentials.loaded accounts=[acct-...] projects=[set|missing] egress=[scheme//host:port]` - no emails, no token paths.

`requestId` is the caller's `x-request-id` when it is short and printable, else `req-` plus twelve hex characters. the `/health` endpoint still lists account emails: it is an operator tool, not the journal.

## systemd

```bash
sudo ./scripts/install-systemd.sh
```

one command — writes the unit, enables, starts. manual path in `docs/systemd.md`.

## structure

```
src/
  config/         defaults, env overrides, loader
  credentials/    token file lookup (agy / gemini-cli / raw), oauth refresh
  rewrite/        openai <-> cloud-code transforms + model catalog
  upstream/       cloud-code client with retry, account pool with cooldown
  server/         http surface: /health, /v1/models, /v1/chat/completions
test/             node:test suite, no network needed (one local cert fixture)
```

## security

- localhost only, unless you know exactly why not
- never commit token files or config.json
- set `apiKey` in config.json if anything besides your own machine can reach the port

## license

MIT
