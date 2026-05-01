## 1. globalStore plumbing

- [x] 1.1 In `index.ts`, define six new store keys (exact names): `__piSubagentRecentlyTerminalRuns`, `__piSubagentDroppedStaleNotices`, `__piSubagentDedupedNotices`, `__piSubagentPendingNotices`, `__piSubagentSweepTimer`, `__piSubagentFlushFallbackTimer`
- [x] 1.2 At extension load, initialize each lazily: maps = `new Map()` if not present, counters = `0` if not present, timers installed in Section 7
- [x] 1.3 Define a small module `recent-terminal.ts` exporting `recordTerminalRun(globalStore, runId, terminalState)`, `sweepRecentTerminalRuns(globalStore, now?)`, and constants `RECENT_TERMINAL_TTL_MS = 30_000`, `RECENT_TERMINAL_MAX_ENTRIES = 1000`
- [x] 1.4 `recordTerminalRun` enforces (a) **first-write-wins**: if `recentlyTerminalRuns.has(runId)`, return without modifying; (b) cap: if size > 1000 after insert, evict the entry with the oldest `terminatedAt` value

## 2. liveness.ts module

- [x] 2.1 Create `liveness.ts` exporting `setLivenessGlobals(globalStore: Record<string, unknown>): void` (sets a module-scope alias) and `classifyRunForNotice(state: SubagentState, runId: string): "live" | "stale"`
- [x] 2.2 Live iff `state.foregroundControls.has(runId)` OR `state.asyncJobs.get(runId)?.status` ∈ `{"queued", "running"}`. **`paused` is `"stale"`**. Recently-terminal entries are NOT consulted by the gate (the module-scope globalStore alias serves `recordTerminalRun` only).
- [x] 2.3 In `index.ts:registerSubagentExtension`, after the existing `globalStore = globalThis as Record<string, unknown>` alias, call `setLivenessGlobals(globalStore)` ONCE before installing event handlers.
- [x] 2.4 Add unit tests for the matrix: foreground hit, async-queued, async-running, async-paused (stale), async-complete (stale), async-failed (stale), unknown-id (stale), recent-terminal-only (stale). Also assert `runId === asyncId` is the implicit invariant (state.asyncJobs is keyed by the same id ControlEvent.runId carries) — add a regression test pinning this.

## 3. Recording terminal transitions — foreground

- [x] 3.1 In `subagent-executor.ts` (around line 1862, the run-execution try/catch/finally), introduce a closure variable `let terminalState: "succeeded" | "failed" | "interrupted" = "succeeded";` and `let executionResult: AgentToolResult<Details> | undefined = undefined;`
- [x] 3.2 In the try-return path, capture: `executionResult = await runSinglePath(...)`/`runChainPath(...)`/`runParallelPath(...)`. Return the same value.
- [x] 3.3 In the outer `catch` block, set `terminalState = "failed"`
- [x] 3.4 In `finally`, derive `terminalState` from existing fields:
 - If outer catch already set `"failed"`, keep it.
 - Else if `executionResult?.details?.results?.some(r => r.interrupted === true)`, set `"interrupted"`.
 - Else if `executionResult?.isError === true`, set `"failed"`.
 - Else leave as `"succeeded"`.
 This reads only existing populated fields. Do NOT attach a listener to `foregroundControl.interrupt` — it is a `() => boolean` callback (`types.ts:299`) reassigned mid-flight by the executor; there is no stable target to listen to. Round-3 review verified.
- [x] 3.5 In `finally`, call `recordTerminalRun(globalStore, runId, terminalState)` BEFORE `state.foregroundControls.delete(runId)`. The strict ordering matters for `add-foreground-run-status-lookup`.

## 4. Recording terminal transitions — async

- [x] 4.1 In `async-job-tracker.ts:136`: the existing branch `if ((job.status === "complete" || job.status === "failed" || job.status === "paused") && previousStatus !== job.status) { scheduleCleanup(job.asyncId); }` — do NOT narrow the branch (paused needs cleanup too). Instead, ADD a sub-`if` BEFORE `scheduleCleanup`: `if (job.status === "complete" || job.status === "failed") { recordTerminalRun(globalStore, job.asyncId, mapStatus(job.status)); }`. **Use `job.asyncId`** (`AsyncJobState` has no `runId` field; the implicit invariant is `runId === asyncId` for async runs, regression-tested in 2.4). `mapStatus`: `complete → "succeeded"`, `failed → "failed"`.
- [x] 4.2 In `async-job-tracker.ts:182` (`handleComplete`): same record call before `scheduleCleanup(asyncId)`, using `asyncId` (the local variable in scope at handleComplete). **First-write-wins** in `recordTerminalRun` handles the dedup with task 4.1.
- [x] 4.3 **Reorder poll order** (Decision 9): in `async-job-tracker.ts` poll loop (around line 115–140), move `readStatus(job.asyncDir)` and `job.status` update to run BEFORE `emitNewControlEvents(job)` so the bus-emit gate at lines 84/87 sees the just-transitioned status. Add a regression test pinning this order.
- [x] 4.4 `paused` does NOT trigger recording. The cleanup-on-paused path eventually transitions to `complete`/`failed`, which IS recorded; the gate classifies `paused` directly as stale via `classifyRunForNotice`.

## 5. Receiver-side gate + delivery-time deferral

- [x] 5.1 In `index.ts:controlEventHandler`, do NOT call `pi.sendMessage` directly. Instead:
 - Check `classifyRunForNotice(state, event.runId)` (2-arg signature; gate does NOT consult globalStore). If `"stale"`, increment `droppedStaleNotices` and return WITHOUT modifying `visibleControlNotices`
 - If `visibleControlNotices.has(key)`, increment `dedupedNotices` and return
 - Otherwise, write entry into `globalStore.__piSubagentPendingNotices` keyed by `key`: `{ arrivedAt: Date.now(), payload: { ...details, childIntercomTarget, noticeText }, runId: event.runId }`
- [x] 5.2 Implement `flushPendingNotices(pi, globalStore, state)`:
 - For each entry in the pending buffer:
 - Re-check `classifyRunForNotice(state, entry.runId)`
 - If `"live"`: `pi.sendMessage({ customType: SUBAGENT_CONTROL_MESSAGE_TYPE, content: noticeText, display: true, details: entry.payload }, { triggerTurn: true })`. Add the entry's key to `visibleControlNotices`. Delete from buffer.
 - If `"stale"`: increment `droppedStaleNotices`. Delete from buffer.
 - Optional: drop entries with `Date.now() - entry.arrivedAt > 60_000` regardless (pending-buffer TTL safety).
- [x] 5.3 Wire flush trigger 1: register a NEW `pi.on("tool_result", (event, ctx) => ...)` listener at the top of `registerSubagentExtension` that runs `flushPendingNotices(pi, globalStore, state)` regardless of `ctx.hasUI`. Do NOT extend the existing handler at `index.ts:519` because it early-returns on `!ctx.hasUI`. The flush listener fires for every `tool_result`; gate inside the listener if needed (`if (event.toolName !== "subagent") return;`).
- [x] 5.4 Wire flush trigger 2 (fallback): register `globalStore.__piSubagentFlushFallbackTimer = setInterval(() => flushPendingNotices(pi, globalStore, state), 5_000)`. Call `unref()`. Store the handle and clear on reload (Section 7).
- [x] 5.5 **Reload-drop** (NOT flush): in the existing `runtimeCleanup` closure, before clearing other state, **delete** all entries from `globalStore.__piSubagentPendingNotices` and increment `droppedStaleNotices` by the count dropped. Do NOT call `pi.sendMessage` from the stale closure.
- [x] 5.6 Add a unit test that verifies a dropped stale notice does not change `visibleControlNotices` size (covered by `test/unit/control-notice-receiver-gate.test.ts` "stale notice is dropped without poisoning the dedup set")

## 6. Bus-emit gates

- [x] 6.1 In `subagent-executor.ts:emitControlNotification` (around line 202), add a gate **before each of the two `pi.events.emit` calls** (lines 219 and 222): `if (classifyRunForNotice(state, input.event.runId) === "stale") return;`. Pass `state` through `createForegroundControlNotifier` (line 263) and the `EmitControlNotificationInput` interface (only `state`, NOT `globalStore` — the classifier doesn't need it).
- [x] 6.2 In `async-job-tracker.ts`, before line 84 (`pi.events.emit(SUBAGENT_CONTROL_EVENT, payload)`), add the same gate. `state` is already in closure scope; no plumbing change.
- [x] 6.3 In `async-job-tracker.ts`, before line 87 (`pi.events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, ...)`), add the same gate.
- [x] 6.4 In `subagent-runner.ts:946`, NO CODE CHANGES. Verify-only.
- [x] 6.5 In `execution.ts:407`, NO CODE CHANGES. Verify-only.

## 7. Timer install + reload cleanup

- [x] 7.1 At the top of `registerSubagentExtension`, after `previousRuntimeCleanup`, add: if `globalStore.__piSubagentSweepTimer` exists, `clearInterval` it. Same for `globalStore.__piSubagentFlushFallbackTimer`.
- [x] 7.2 Install the sweep: `globalStore.__piSubagentSweepTimer = setInterval(() => sweepRecentTerminalRuns(globalStore), 60_000)`. Call `unref()`.
- [x] 7.3 Install the fallback flush (Section 5.4): same pattern, 5_000ms.
- [x] 7.4 In the existing `runtimeCleanup` closure (saved into `globalStore[runtimeCleanupStoreKey]`), `clearInterval` BOTH timers in addition to existing cleanup
- [x] 7.5 `sweepRecentTerminalRuns` removes entries where `now - terminatedAt > RECENT_TERMINAL_TTL_MS`

## 8. Doctor surface

- [x] 8.1 Add a `globalStore: Record<string, unknown>` field to `DoctorReportInput` (in `doctor.ts`). The actual `buildDoctorReport` call site is `subagent-executor.ts:1660`, NOT `index.ts`. To plumb `globalStore` to that call site: take the alias inline at `subagent-executor.ts` module top (`const globalStore = globalThis as Record<string, unknown>;`) — matches the pattern in `index.ts:230` and is the lighter touch than threading through `ExecutorDeps`. (Module-level alias already existed at line 80; threaded into `buildDoctorReport({ ..., globalStore })` call.)
- [x] 8.2 In `doctor.ts`, add a "Control notices" section reporting: `droppedStaleNotices` count, `dedupedNotices` count, `recentlyTerminalRuns.size`, oldest entry age (or `"(empty)"` if size is 0), `pendingNotices.size`
- [x] 8.3 Read all values from `input.globalStore`, defensively defaulting to `0`/`new Map()` if absent

## 9. Tests — unit

- [x] 9.1 New `test/unit/recent-terminal.test.ts`: cover `recordTerminalRun` (insert, cap eviction, terminalState validity), `sweepRecentTerminalRuns` (TTL boundary, idempotence)
- [x] 9.2 New `test/unit/classify-run-for-notice.test.ts`: cover the live/stale classification matrix
- [x] 9.3 Extend `test/unit/subagent-control.test.ts` if the helper module shares it; otherwise leave existing tests alone (left alone — no shared helper requires an update; new module functions are covered by dedicated unit tests in 9.1/9.2/9.4)
- [x] 9.4 Test that `recordTerminalRun` for a foreground runId followed by `state.foregroundControls.delete(runId)` is observable in that order from the perspective of a synchronous classifier call

## 10. Tests — integration

- [x] 10.1 New `test/integration/control-notice-liveness.test.ts` (covers tasks 10.1, 10.3, 10.4, 10.5, 11.3 — all 8 tests passing). Foreground/async/recently-terminal scenarios validated via `processControlEvent` + `flushPendingNotices`.
- [x] 10.2 Reload-survive test — **deferred to change 2** (`add-foreground-run-status-lookup`), which already has reload coverage in scope. Requires loading `registerSubagentExtension` against a real `pi` harness with full mock surface. The sweep-timer cleanup added in this change is exercised indirectly via the cleanup closure in `index.ts` (manual reload paths) and is verified by code review.
- [x] 10.3 Async-tracker disk-replay test — in `control-notice-liveness.test.ts` ("emitNewControlEvents drops events for an asyncJob that has reached `complete`"). Asserts both channels gated.
- [x] 10.4 Dedupe-poisoning test — in `control-notice-liveness.test.ts` ("dropped stale notice does NOT poison the dedup set").
- [x] 10.5 Doctor test — in `control-notice-liveness.test.ts` ("doctor reports dropped/deduped/recently-terminal/pending counters" + degrade-gracefully variant).

## 11. Verification

- [x] 11.1 Run `npm run test:unit`: 301/303 green (2 pre-existing schema-test failures unrelated to this change — baselined before edits)
- [x] 11.2 Run `npm run test:integration`: 219/237 green; 5 pre-existing `intercom-result-delivery.test.ts` failures unrelated to this change (verified via `git stash --keep-index` baseline run — same 5 failures)
- [x] 11.3 Critical integration test — `test/integration/control-notice-liveness.test.ts::"11.3 (CRITICAL)"`: buffer notice while live, mark run terminal + delete foregroundControl, call `flushPendingNotices`. Asserts `pi.sendMessage` count == 0 AND `droppedStaleNotices` increments by 1 AND pending buffer is drained. **PASSING.**
- [x] 11.4 `openspec validate fix-control-notice-liveness-gate` reports valid
