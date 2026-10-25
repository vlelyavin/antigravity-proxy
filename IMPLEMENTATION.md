# implementation report - bounded relay fix

## result

- exact sha: `f0e81423ff1abd8fea244370f784fa2bb7555229`
- base: `4331a36faa03b18869d1a72af2a04d35d1288942` (immutable live-relay base, unchanged)
- branch: `master`, working tree clean apart from this report and the untracked brief
- checks: `node --test` -> **148 tests, 148 pass, 0 fail** (baseline 141), three consecutive green runs (~8.5 s each)
- no npm install, no dependencies, no network, no ssh, no docker, no system config, no push/deploy

## diff

```
 README.md                       |   9 ++-
 docs/architecture.md            |  26 +++++-
 src/server/handlers.js          | 136 ++++++++++++++++++++++++++++++--
 test/log-privacy.test.js        |  39 ++++++++++
 test/non-stream-collect.test.js | 154 ++++++++++++++++++++++++--------
 test/reliability.test.js        |  25 ++++++
 test/terminal-outcome.test.js   | 172 +++++++++++++++++++++++++++++++++----
 test/vertex-fallback.test.js    |   1 +
 8 files changed, 486 insertions(+), 76 deletions(-)
```

## reproduced before the fix (six synthetic accounts, local handler + end-to-end server)

| scenario | before | after |
|---|---|---|
| non-stream, 6 accounts, every answer without finishReason | 6 upstream calls, 6 `account.cooldown`, pool empty, journal `outcome=transient reason=truncated:502` x6 | 2 calls, 0 cooldowns, 6/6 healthy, journal `outcome=protocol reason=truncated:502` x2 |
| same request through `createServer` | - | client gets 502 `upstream response ended without a finish reason (truncated)`; next normal request answers 200 on the first account |
| 3 accounts, one already cooling after a genuine 429, then a truncated answer | final error `quota:429 "all accounts are cooling down (rate limited)"` (fabricated) | final error `truncated:502`, the real failure |

## what changed (src/server/handlers.js)

1. **protocol failures are their own class.** `PROTOCOL_FAILURE_KINDS = {truncated, terminal, malformed}`,
   `MAX_PROTOCOL_ATTEMPTS = 2`, exported `isProtocolFailure(error)`. The rotation catch gets a
   `protocol` branch before the transport branch: no `pool.cooldown`, no `upstream.invalidate`,
   `retry = protocolAttempts < 2`. It is gated by `!res.headersSent`, so the no-retry-after-caller-bytes
   rule is untouched; a protocol failure of an already-open client stream is still `stream_failed`
   (`reported`) and never rotates. Quota/auth/transport branches are byte-for-byte unchanged, so their
   failover still uses the whole pool; `maxAttempts`, the request deadline and the attempt ladder are
   unchanged.
2. **`pool.pick` returning null** keeps a prior non-quota failure; the fabricated
   `all accounts are cooling down (rate limited)` 429 is created only when there is no prior error or
   the prior one is itself quota. Initially exhausted pools still answer 429.
3. **wrapped error objects.** One helper `explicitUpstreamError(payload)` = `payload.error ||
   payload.response.error`, used at all three existing error-check sites (non-stream plain JSON body,
   non-stream SSE frame, client-stream SSE frame). `upstreamErrorFrom(status, text, accountId)` is
   untouched, so status classification (429 quota, 401 auth, 5xx transport) is identical. Nothing else
   is unwrapped or translated differently.
4. **bounded diagnostics.** The collector is now `collectCompletion` (logs on rejection, rethrows the
   original object) around `collectFrames(options, shape)`, which counts frames with
   `observeFrameShape`. One `chat.collect_failed` line per rejected non-stream collection:
   `requestId, account, endClass(error|abort), frameCount, candidateCount(last frame), textFrames,
   reasoningFrames, toolFrames, signatureOnlyFrames, terminalSeen, wrappedError`. Fixed names, numbers,
   two booleans, one enum; no key, text, tool name, argument, signature, media, upstream message or raw
   frame. Existing logger, no config, no tracing framework. The plain-object-header path
   (`hasHeaders`/`hasStream`) is unchanged. The streaming lane is deliberately not instrumented
   (README says so).

## regressions (all in existing test files, table cases where natural)

| required case | where |
|---|---|
| six all-truncated -> 2 attempts, zero cooled, final 502, all six healthy; next request succeeds immediately | `terminal-outcome.test.js` "six truncating accounts stop after two protocol attempts..." |
| first protocol failure + second STOP succeeds (terminal / truncated / malformed table) | `terminal-outcome.test.js` "a protocol failure fails the attempt, gets one alternate account and cools nobody" (replaces the test that asserted the old cool-and-fail-over policy; its strictness assertions are kept, the policy assertion is inverted per the brief) |
| two protocol failures mixed with a real quota: protocol accounts not cooled | `terminal-outcome.test.js` "protocol failures mixed with a real quota failure cool only the quota account" |
| spent pool keeps the real failure instead of the fabricated 429 | `terminal-outcome.test.js` "a spent pool keeps the real protocol failure instead of a fabricated quota 429" |
| quota-only still 429 and cools | `vertex-fallback.test.js` "fallback disabled -> upstream 429 propagates" (extended) + existing `reliability.test.js` M9 / quota-rotation tests |
| transport 502 still cools and fails over | `reliability.test.js` "a transport 502 still cools that account and fails over to the next one" (fake upstream learned `p-502`) |
| wrapped error classified correctly in JSON, SSE frame and client stream | `non-stream-collect.test.js` (two tables) and `terminal-outcome.test.js` "an upstream error inside the response wrapper is an error frame..." |
| terminal guard: tool/no-terminal still rejected | unchanged tests in `terminal-outcome.test.js` / `non-stream-collect.test.js` (validator untouched) |
| diagnostics sentinel privacy + bounded fields + abort class | `log-privacy.test.js` "a rejected non-stream collection journals its bounded shape, never its content"; `non-stream-collect.test.js` "a rejected collection journals its bounded shape and never its content" |

No existing test was deleted or weakened to hide breakage; the only inverted expectation is the one
that documented the defective cooling policy itself.

## docs (same commit)

- `README.md`: sticky-first selection (all accounts as overflow) instead of round-robin; a
  "protocol failures and the pool" paragraph contrasting the two-attempt protocol cap with the
  quota/transport cooldown-and-failover policy; the wrapped-error rule next to the terminal guard; the
  `chat.collect_failed` journal bullet with its fixed field list.
- `docs/architecture.md`: diagram claims corrected (`rotation loop (up to 3 accounts)` ->
  `rotation loop (sticky first)`, `round-robin + 429 cooldown` -> `sticky-first + quota cooldown`) and a
  new "accounts and failure classes" section with the protocol/transport/quota split, the spent-pool
  rule and the diagnostics contract.

## limits and remaining findings

- **the original upstream cause is not fixed and is not claimed to be.** Why the backend truncated that
  media+history generation is unknown; this change makes one request cost two accounts and zero
  cooldowns instead of six and six, and makes the next request work. It does not pretend to fix
  upstream truncation.
- the terminal validator, signature/tool replay, model catalog, limits, Vertex/native lanes and the
  translator are untouched. The Vertex fallback still runs after the pool is spent, exactly as before
  (it is a separate lane, not a pool attempt); with the incident configuration it evidently answered
  nothing.
- `endClass` can only be `error` or `abort` here because the line is emitted on rejection only; `clean`
  exists in the documented enum but is never emitted. Documented in code and README.
- diagnostics cover the non-stream collection only. The client-stream lane has no equivalent counters
  by design (the brief allows leaving it out; README says so explicitly).
- the protocol cap applies to pre-header protocol failures in general; in practice these can only come
  from the non-stream collection, because the client-stream collector throws only after its headers are
  written (that path is `stream_failed` and never rotates).
- `README.ru.md` (line 12 and the `## мультиаккаунт` section) still carries the same stale
  round-robin wording and the older policy summary. It was outside the brief's file scope
  (`README.md/docs/architecture.md`), so it was left untouched rather than half-updated; fixing it is a
  one-paragraph change if wanted.
- no live relay, credentials, network or production state was touched, so nothing here is evidence
  about the live six-account incident beyond the synthetic replay above.
