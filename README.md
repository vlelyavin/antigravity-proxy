# antigravity-proxy

[README на русском](README.ru.md)

If you have a Google AI Pro subscription but your developer tools expect an OpenAI-compatible endpoint, this project bridges the gap. It is a lightweight local relay that proxies OpenAI `chat/completions` requests through your Antigravity or Code Assist OAuth credentials, letting tools like Hermes, OpenCode, or any OpenAI-compatible client run on your existing subscription instead of racking up per-token API bills.

## what it does

- **Hot-reloads credentials**: Reads your local Antigravity/Gemini OAuth token from disk on every request. Re-authenticating in another tool takes effect immediately without restarting the proxy.
- **Bi-directional translation**: Handles structural conversion between OpenAI `chat/completions` and Cloud Code `generateContent` formats, including tool calls and image payloads.
- **Real-time streaming**: Re-encodes Cloud Code SSE frames into OpenAI-compatible SSE streams on the fly.
- **Multi-account rotation**: Distributes requests across multiple accounts with automatic cooldowns on HTTP 429 (rate-limit) errors. Drop in multiple token files, and the proxy will round-robin between them.
- **Resilient retries**: Automatically retries on 5xx errors and network failures with exponential backoff. When an account hits quota limits, the proxy fails over to the next available account instead of dropping the request.
- **Local access control**: Optional API key support to prevent unauthorized access across your local network.
- **Zero dependencies**: Built entirely on the Node.js standard library with no external npm packages.

## what it is not

- Not an official Google product and not affiliated with Google in any way.
- Not a hosted service: it runs entirely on your local machine using your own credentials.
- Not a credential source: this repository contains no tokens, credentials, or private keys.

## straight talk

This proxy relies on subscription OAuth credentials outside the official client workflow. This sits in a gray area regarding Google's Terms of Service, alongside other third-party Code Assist tooling. Aggressive use or quota abuse can put your subscription at risk of suspension. The daily quota is shared per user (~1,500 requests/day on AI Pro), and iterative agentic loops can consume requests rapidly. Use it at your own discretion.

## requirements

- Node.js 20+ (no build step, no `npm install` required)
- A local OAuth token from any of the following:
  - **antigravity cli** (`agy`): `~/.gemini/antigravity-cli/antigravity-oauth-token`
  - **gemini cli** (`npm i -g @google/gemini-cli && gemini`): `~/.gemini/oauth_creds.json`
  - Any custom JSON file containing `{access_token, refresh_token, project_id?}` saved under `~/.antigravity-proxy/accounts/*.json`

## run

```bash
git clone https://github.com/vlelyavin/antigravity-proxy.git
cd antigravity-proxy
node src/cli.js
```

The server listens on `127.0.0.1:8317` by default.

Verify the status and inspect discovered accounts:

```bash
curl -sS http://127.0.0.1:8317/health
```

The health check response will list all detected accounts and their token expiration times.

Send a test completion:

```bash
curl -sS http://127.0.0.1:8317/v1/chat/completions \
  -H 'content-type: application/json' \
  --data '{"model":"gemini-3.8-flash-high","messages":[{"role":"user","content":"reply with exactly: pong"}]}'
```

Receiving `pong` confirms that credentials, translation, and upstream connectivity are fully operational.

## wire it into tools

Set the OpenAI-compatible base URL to `http://127.0.0.1:8317/v1`. If you configured an API key, provide it here; otherwise, use any non-empty placeholder like `none`.

OpenCode configuration:

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

For Hermes or standard OpenAI SDKs: configure `base_url=http://127.0.0.1:8317/v1`, set `api_key=none`, and query `GET /v1/models` for available model IDs.

## models

Supported model IDs include `gemini-3.8-flash-{low,medium,high}`, `gemini-3.7/3.6-flash-*`, `gemini-3-flash`, `gemini-3.1-pro-{low,high}`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, and `gpt-oss-120b-medium`. The full registry is defined in `src/rewrite/models.js` and can be expanded as new models become available upstream.

## multi-account

To use multiple accounts, place token files in `~/.antigravity-proxy/accounts/*.json` matching the structure `{access_token, refresh_token, project_id?, email?}`. The proxy will cycle through healthy accounts via round-robin. If an account returns HTTP 429, it enters a cooldown window and the proxy immediately retries the request using the next available account. A practical guideline is keeping 2-3 accounts per residential IP; running larger pools from a single IP increases the risk of CAPTCHAs or quota blocks.

Non-streaming requests travel upstream over the streaming endpoint and get stitched back into one JSON answer: the plain collect-then-reply call waits for the whole answer and on long texts overshoots any sane deadline, while the stream returns the first token in seconds. Each attempt still has its own budget, `rotation.attemptTimeoutsMs` (90s, 90s, 60s, 60s, 45s, 45s, 45s in the shipped config; the last value repeats), so a hung account is skipped instead of holding the client. A client can override the ladder with the `x-attempt-timeouts-ms` header, e.g. `45000,30000`, on non-streaming requests.

## systemd

```bash
sudo ./scripts/install-systemd.sh
```

This script generates the systemd unit file, enables it, and starts the service. Manual setup instructions are documented in `docs/systemd.md`.

## structure

```
src/
  config/         Configuration defaults, environment variable overrides, loader
  credentials/    Token discovery (agy, gemini-cli, raw JSON) and OAuth refresh handling
  rewrite/        OpenAI <-> Cloud Code transforms and model catalog
  upstream/       Cloud Code client with retry logic and account rotation pool
  server/         HTTP routing: /health, /v1/models, /v1/chat/completions
test/             34 test cases, fully offline (no network required)
```

## security

- Bind to `127.0.0.1` unless you have an explicit network architecture requiring external exposure.
- Never commit credentials, token files, or `config.json` to version control.
- Configure an `apiKey` in `config.json` if the port is reachable by other devices on your local network.

## license

MIT
