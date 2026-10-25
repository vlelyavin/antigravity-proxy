# Relay wave 2026-10-24: cancellation, collection integrity, one request deadline

Branch `wave/relay-20261024`, base `f61ae0d` (cloned from system-vm). Work happened only in
`/home/vlelyavin/dsh-workspaces/mari-relay-20261024`: no SSH, no deploy, no push, no live service,
no journal or production-config read. Every check below ran locally against this checkout with a
synthetic upstream; no external traffic, no prompt, token or media bytes are logged or stored.

Effective live numbers this work targets (from the brief, older briefs are stale): service attempt
ladder `[90000,90000,60000,60000,45000,45000,45000]`, upstream `requestTimeoutMs` 120000, rotation
`cooldownMs` 45000, Vertex fallback disabled.

## What changed

### `src/server/create-server.js` - the caller's disconnect is visible

- `req.on('close')` fired as soon as the request body had been read (Node >= 16 behaviour), so the
  old abort controller never fired for a caller that hung up while the answer was pending - the
  reproduction measured the upstream signal still alive 100 ms after the disconnect. Cancellation is
  now observed on the response: `res.on('close')` with `writableFinished` unset means the connection
  died before the response finished; a finished response is not a cancellation. Recorded because
  "req close is safe" in the audit is disproved.
- The listener is removed in a `finally` (`client.stop()`), so no per-request listener survives it.
  Both the chat and the native lane use it.
- `readBody(req, res, limitBytes)` now takes the response it writes to. The oversize path used to
  reference an undefined `res` (a `ReferenceError` thrown from the request's `data` handler, i.e. an
  uncaught exception: the client never saw 413 and the relay process died). It now answers an
  explicit 413 with `content-length` and `connection: close`, flushes it, then destroys the request.
  Rejections carry `tooLarge` / `clientAborted` so the handler answers only when somebody is left:
  a 413 is not answered twice, a caller that left mid-upload gets no answer at all.
- The 32 MiB limit itself is unchanged.

### `src/server/handlers.js` - one request budget, cancellation is not a failure

- One absolute request deadline (`rotation.requestDeadlineMs`, default 110000, configurable up to
  600000) starts at the top of `handleWithRotation` and covers preparation (credential read, token
  refresh wait, project lookup, body build), every rotation attempt, the non-stream collection and
  the last-resort fallback. It never resets.
- Per attempt the cap is `min(ladder value, time left in the budget)`. The ladder (`attemptTimeoutsMs`
  from `x-attempt-timeouts-ms` or `rotation.attemptTimeoutsMs`) still applies to non-stream requests
  only, as documented before; a client-facing stream has no ladder, only what is left of the budget.
  Both caps are absolute timers started once per attempt: a keepalive frame cannot extend them.
- Three abort sources stay distinguishable: caller disconnect (`signal.aborted`), request deadline
  (own controller plus a wall-clock check), attempt cap. Classification order in the attempt catch is
  caller, then deadline, then attempt cap, then the pre-existing quota/auth/transient rotation.
- A caller abort or a spent deadline cools no account, starts no further attempt and never starts the
  fallback. A ladder timeout still rotates to the next account, and only a spent budget stops it.
- The fallback gets `min(fallback.timeoutMs, what is left of the request budget)` and the same
  request signal; it is not started at all when the request is cancelled or out of time. Fallback
  activation itself is untouched (still opt-in through `fallback.enabled`, disabled live).
- Non-stream collection (`collectCompletion`) keeps what the streaming lane carries:
  - `thought_signature` on tool calls reaches the collected JSON instead of being dropped, together
    with `id`, `type`, function name and the arguments concatenated per call index.
  - a prompt-level block keeps `message.refusal` and `finish_reason: content_filter`.
  - `finish_reason` is now the explicit terminal reason of the upstream (including `length`); a
    stream that ends without one is rejected with `UpstreamError` 502 (truncated) instead of being
    reported as a successful `stop`.
  - explicit upstream error objects (SSE `{"error":{...}}` frames and JSON bodies on the streaming
    endpoint) become rotation-ready `UpstreamError`s via the same mapping the HTTP status path uses,
    so a 429 frame cools and rotates exactly like an HTTP 429.
  - malformed SSE lines are a 502 protocol failure instead of a silently skipped line.
  - the last line of a stream without a trailing newline is read, and the decoder is flushed at EOF.
  - the native vision lane (`respondNative`) and the `generateContent` JSON branch are untouched, so
    native bodies and the tool-replay path keep their semantics.
- The client-facing SSE pump now waits for backpressure through `drainOrAbort`, which stops on
  abort or on response close: a lost caller no longer parks the pump with the upstream body open.
  All listeners and timers added for an attempt are removed or cleared when it ends.
- Cancellation checks exist before preparation, before the pre-flight retry (also in
  `upstream-client.js`) and on every collected/forwarded line.
- New journal lines (`info`, one per attempt plus one per request), no email, no token, no prompt,
  no payload bytes:
  - `attempt.timing requestId=<id> attempt=<n> account=acct-<index> stream=<bool> outcome=<...> status=<http|null> reason=<kind:status|client_disconnected|null> prepMs=<n|null> firstFrameMs=<n|null> totalMs=<n>`
  - `request.timing requestId=<id> outcome=<ok|failed|deadline|client_abort|vertex_fallback> status=<http|null> reason=<...> attempts=<n> totalMs=<n> deadlineMs=<n>`
  - `requestId` is the caller's `x-request-id` when it arrives (sanitised, max 64 printable chars),
    else `req-<12 hex>`. The alias is the account's index in credential order, the same order the
    startup `credentials.loaded` line prints; emails stay out of the timing lines.

### `src/upstream/upstream-client.js` - classification and retry guards

- `upstreamErrorFrom` is now a module function (the class method was moved, not duplicated) and
  `upstreamErrorFromJson` maps an explicit error object through it.
- `abortable` rejects with the signal's own reason, so an abort is no longer re-labelled as an
  upstream error.
- `#doFetch` refuses to start an already cancelled request, does not turn a caller abort into a
  pre-flight failure, does not re-POST for a caller that left while the first attempt was failing,
  and reports an abort after the second attempt as an abort. The upstream `requestTimeoutMs` timeout
  keeps its old mapping (504).
- The shared OAuth refresh is unchanged: a cancelled caller only stops waiting for the shared
  promise (deduplicated in `this.refreshing`); the refresh itself is never cancelled.

### `src/config/defaults.js`, `config.example.json`, `README.md`

- `rotation.requestDeadlineMs: 110000` documented with its range and purpose; README's multi-account
  section describes the total budget and the clamped ladder. No other default changed (cooldown,
  upstream timeout, fallback defaults are as before).

## Timer choices, exactly

| timer | start | length | reset by | outcome |
|---|---|---|---|---|
| request deadline | entry of `handleWithRotation` | `rotation.requestDeadlineMs`, default 110 s, clamped to (0, 600 s] | nothing | 504, no cooldown, no further attempt or fallback |
| attempt cap | start of one attempt | `min(ladder[i], deadline - now)`, only when a ladder exists and the request is non-stream | nothing | rotate to the next account; no cooldown |
| upstream request | each upstream POST | `upstream.requestTimeoutMs` 120 s (existing) | nothing | 504, existing rotation path |

Why 110 s: Mari's main call is capped at 120 s (`LlmHttpClient`), so the relay's own budget has to
end before the client gives up, while leaving a little room for the response to be written. The
default does not depend on any caller header: `x-attempt-timeouts-ms` only shortens attempts inside
it, and a gateway that drops the header changes nothing about the total. With the live ladder the
first attempt can use 90 s of the 110 s; the second then gets about 20 s (see Concerns).

## Evidence

### The four audit reproductions, against this source

The audit script `reports/sessions/2026-10-23-agy-media-stability/relay-local-checks.mjs` was copied
and re-pointed from `relay-snapshot/` to this checkout (synthetic frames only, no network). Before
the change all four reproduced exactly as reported:

```
signature_in_source_stream            signature lost in collected JSON
clean_eof_without_terminal_frame       returned success with finish_reason=stop
client_abort_in_rotation               one account cooled; second attempt entered (attempts 2)
disconnect_after_request_body_complete upstream signal still active 100 ms after client disconnect
rotation events                        account.cooldown acct=synthetic-a ms=45000, rotation.transient 504
```

After the change the same script with inverted expectations reports:

```
signature_in_source_stream            signature preserved on the collected tool call
clean_eof_without_terminal_frame      rejected: upstream stream ended without a finish reason (truncated)
client_abort_in_rotation              no account cooled, no second attempt (attempts 1)
disconnect_after_request_body_complete upstream signal aborted within 100 ms of the client disconnect
```

The oversize path was reproduced with the old `readBody` verbatim behind a real server: a 2 KiB body
against a 1 KiB limit produced `UNCAUGHT ReferenceError: Cannot access 'res' before initialization`
from the request `data` handler, i.e. no 413 and a dead process. The new code answers 413.

### Live-shaped ladder, scaled 100x locally

Seven accounts, all silent after headers, ladder `[900,900,600,600,450,450,450]` (the live
`[90000,...]` divided by 100) and a 1100 ms budget:

```
status 504 elapsed 1120 upstream starts 2
attempt=0 account=acct-0 outcome=attempt_timeout status=504 total=903
attempt=1 account=acct-1 outcome=deadline        status=504 total=198
request.timing outcome=deadline status=504 total=1102 deadlineMs=1100
cooldowns: 0
```

The first slab is honoured, the second attempt is clamped to what is left, the request ends at the
budget (`1102 ms` for `1100 ms`), two upstream requests only, and no account is cooled.

### Test discrimination (new tests against the pre-fix source)

`git stash push -- src/` and rerun:

- `test/client-cancel.test.js`: the disconnect regression fails; the mid-upload and shared-refresh
  guards pass (they are guards, not regressions).
- `test/non-stream-collect.test.js`: 9 of 11 fail (signature, refusal, truncation, error frame,
  malformed frame, JSON error body, trailing frame, multiple tool calls, streaming error frame); the
  chunk-stitching and native-lane cases pass.
- `test/request-deadline.test.js`: all 5 fail (no deadline existed; they end on the 5 s upstream
  timeout instead).
- `test/body-limit.test.js`: cannot even import the old module (`readBody` was not exported); the
  oversize crash is shown by the standalone reproduction above.

## Checks run

- `node --test` on the branch: **106 tests, 106 pass, 0 fail** (84 pre-existing + 22 new), run three
  times back to back with identical results; total runtime ~8 s.
- `node --check` on the three changed source files: clean.
- 32 MiB boundary through the real server (`test/body-limit.test.js`): a body of
  `32*1024*1024 + 40` bytes gets 413 with `error.code=413`, the upstream is never called, `/health`
  still answers; the run takes ~0.2 s. The exact boundary is covered on a small limit (64 bytes
  accepted, 65 rejected) because the production limit itself is a constant.
- Disconnect mid-upload: `readBody` rejects with `clientAborted`, no upstream call, server still
  serving.
- Shared refresh: two concurrent callers, one aborted at 30 ms; exactly one OAuth refresh, the
  surviving caller gets the token and a 200.
- Keepalive frames: a 400 ms budget with `data: {"response":{}}` every 40 ms ends at ~400 ms with
  504, `firstFrameMs=null`, no cooldown.
- Deadline clamp: ladder `[100, 5000]` under a 300 ms budget gives two attempts and finishes under
  1.5 s (the second attempt does not get its 5000 ms).
- Fallback: enabled but never called when the budget is spent; never called when the caller left.

## Limitations and open concerns

- **Ladder vs budget (config, not code).** With the live ladder `[90000,90000,60000,...]`, the first
  attempt may use 90 s of the 110 s budget, leaving ~20 s for the next account - a cold account often
  needs more for prefill. The failover is bounded and honest now, but if Mari must survive a slow
  first account, the ladder should be re-tuned (for example `45000,30000`), or the budget raised
  only together with Mari's own 120 s. Not changed here: the brief forbade blanket timeout cuts.
- **Client-facing streams.** A stream request now shares the same total budget, so its upstream body
  is cut at 110 s instead of the previous 120 s `requestTimeoutMs`. That path has no flow-aware idle
  deadline; a genuinely long stream lane would need one (the audit's item 4), which is a larger
  design change and was out of scope.
- **Ladder is still non-stream only.** A streaming request has no per-attempt cut by design (kept),
  so a stalled stream preparation is bounded only by the total budget.
- **Plain-JSON upstream bodies.** `antigravityToOpenAi` still defaults `finish_reason` to `stop` for a
  complete JSON body without `finishReason` (the "upstream answered JSON on the SSE endpoint" branch).
  The strict terminal requirement is enforced on the collected SSE lane, where truncation is
  observable; changing the translate-layer default would alter its documented contract and tests.
- **Legacy journal fields.** `chat.completed`, `chat.streamed`, `native.completed`, `oauth.refreshed`
  and the `rotation.*` warnings still print `account.email` (pre-existing). The new timing lines never
  do; changing the legacy lines would break existing journal grep patterns and was left out.
- **Alias stability.** `acct-<index>` follows credential order; reordering the credential files
  renumbers aliases. The startup `credentials.loaded` line is the mapping for that boot.
- **Egress lane cancellation.** The per-account egress path (`node:https` + CONNECT agent) aborts
  through the same signal listener that existed before; the disconnect tests exercise the `fetch`
  path. The agent's `req.destroy` is unchanged, and no test proxies through a CONNECT agent.
- **Dead code noticed, not touched.** In `handleNonStream` the code after the `respondNative` block is
  unreachable (the function returns in both branches of the first `if`). It is pre-existing and
  harmless; removing it is unrelated cleanup.
- **Mail/aliases from the store.** `/health` still lists account emails by design (operator tool), and
  the timings deliberately do not repeat them.
- **No root cause claimed** for the 23.10 incidents: this work removes the proved hazards (cancel
  classified as failure, no total budget, truncated success, oversize crash) and adds the timings
  needed to attribute the next episode.

## Out of scope, untouched

Reasoning medium / thinking config, model and provider selection, account-to-egress isolation,
credential refresh semantics, Vertex or any other fallback activation, prod config, deployment.
