# antigravity-proxy

[README на русском](README.ru.md)

you have a google ai pro subscription. your tools want an openai endpoint. this sits in the middle: a local relay that pushes openai chat-completions through your antigravity / code-assist oauth, so hermes / opencode / anything-openai rides on the sub instead of a per-token bill.

## what it does

- reads your local antigravity/gemini oauth token from disk on every request — a fresh login elsewhere needs no restart
- translates openai `chat/completions` ↔ cloud code `generateContent` structurally, both directions, including tool calls and images
- streams: openai SSE out of the cloud-code SSE frames
- multi-account round-robin with 429 cooldown — drop N token files in and it rotates
- retries 5xx/network with backoff; quota errors rotate accounts instead of failing the request
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

`gemini-3.8-flash-{low,medium,high}`, `gemini-3.7/3.6-flash-*`, `gemini-3-flash`, `gemini-3.1-pro-{low,high}`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`. the list lives in `src/rewrite/openai-translate.js` — extend it when google ships more.

## multi-account

put extra token files under `~/.antigravity-proxy/accounts/*.json` (shape: `{access_token, refresh_token, project_id?, email?}`). round-robin picks the next healthy account; a 429 puts that account on cooldown and retries the next. 2-3 accounts per residential exit ip is the sane ceiling — more looks like a farm, and google farms get recaptcha'd.

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
test/             22 tests, no network needed
```

## security

- localhost only, unless you know exactly why not
- never commit token files or config.json
- set `apiKey` in config.json if anything besides your own machine can reach the port

## license

MIT
