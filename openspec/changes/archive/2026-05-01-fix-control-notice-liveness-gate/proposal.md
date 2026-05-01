## Why

Subagent control notices ("needs_attention") are emitted by the per-run
activity watchdog and delivered to the parent via `pi.sendMessage(...,
{ triggerTurn: true })`. The bug timing matters: a notice fires while the
run is **still live** (the watchdog tripped), so a naive receiver-side
gate sees `state.foregroundControls.has(runId) === true` and lets the
message through. The message is then queued behind the parent's
in-progress tool call (e.g., a long parallel batch). By the time the
parent processes it, the run has finished, `foregroundControls.delete(
runId)` has run, and `subagent({action:"status", id})` returns "Async run
not found." The notice has become stale post-buffer.

This change introduces a **delivery-time gate**: notices are buffered in
`globalStore.__piSubagentPendingNotices` instead of being passed to
`pi.sendMessage` immediately. The buffer is flushed on `pi.on(
"tool_result")` (already-hooked) and on a 5-second fallback timer; at
flush, the run's liveness is re-checked. Notices whose runs went stale
during the buffering interval are dropped.

Recently-terminal *visibility* (so a parent that does call `status` after
the gate drops a notice can still get a useful answer) is the
responsibility of `add-foreground-run-status-lookup`, sequenced to land
immediately after this change.

## What Changes

- Introduce `recentlyTerminalRuns` and `droppedStaleNotices` in
 `globalStore` (not `state`) so they survive `ctx.reload()` patterns
 used elsewhere in `index.ts`.
- Record terminal transitions for runs into `recentlyTerminalRuns` at the
 *transition moment* — not at cleanup time. Three concrete sites:
 - Foreground: in the `finally` block at `subagent-executor.ts:1882`
 that calls `state.foregroundControls.delete(runId)`. Capture
 `terminalState` via a closure variable set on the success path,
 catch path, and `result.interrupted` path (read from the returned
 `AgentToolResult.details.results[*].interrupted`).
 - Async-tracker poll branch: `async-job-tracker.ts:136` where
 `previousStatus !== job.status` and `job.status` is in `{complete,
 failed}`. **`paused` is treated as stale** because the current async tracker schedules cleanup for paused runs (`async-job-tracker.ts:136-137`) and there is no resume API. If a paused-as-resumable lifecycle lands later, the classifier should be revisited.
 - Async-tracker `handleComplete`: `async-job-tracker.ts:182` before
 the `scheduleCleanup` call.
- Add a helper `classifyRunForNotice(state, runId): "live" | "stale"`
 that returns `"live"` iff the runId is in
 `state.foregroundControls` OR in `state.asyncJobs` with `status` in
 `{queued, running}`. **`paused` is treated as stale/terminal** because
 current code schedules cleanup for paused runs (`async-job-tracker.ts:
 136-137`) and there is no resume API in the surfaced tool surface.
 All other ids — including those in `recentlyTerminalRuns` — return
 `"stale"`.
- In `index.ts:controlEventHandler`, write the notice into
 `globalStore.__piSubagentPendingNotices` (a `Map<noticeKey, {arrivedAt,
 payload, runId}>`) instead of calling `pi.sendMessage` directly.
 Re-checking liveness happens at flush, not at write.
- **Flush triggers**:
 1. `pi.on("tool_result", ...)` — already registered at `index.ts:519`.
 Walk the buffer; for each entry, re-check `classifyRunForNotice`.
 Live → call `pi.sendMessage(...)`. Stale → drop and increment
 `droppedStaleNotices`.
 2. Fallback `setInterval(flushPendingNotices, 5_000).unref()`.
 Catches the case where no `tool_result` fires for a long time (e.g.,
 async runs without parallel parents).
- Gate emit-side notices at four bus-emit sites (the only places
 `pi.events.emit` for control/intercom events is called):
 1. `subagent-executor.ts:219` (`emitControlNotification` →
 `pi.events.emit(SUBAGENT_CONTROL_EVENT, ...)`)
 2. `subagent-executor.ts:222` (`emitControlNotification` →
 `pi.events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, ...)`)
 3. `async-job-tracker.ts:84` (`pi.events.emit(SUBAGENT_CONTROL_EVENT,
 payload)`)
 4. `async-job-tracker.ts:87` (`pi.events.emit(
 SUBAGENT_CONTROL_INTERCOM_EVENT, ...)`)
 The pre-existing derive-state guards in `execution.ts:407` and
 `subagent-runner.ts:946` are NOT bus-emit sites — they prevent the
 *event* from being built at all. They are kept as-is for noise
 reduction; this change does not modify them.
- `recordTerminalRun` is **first-write-wins**: if
 `recentlyTerminalRuns.has(runId)`, the function returns without
 overwriting `terminatedAt`. This dedupes the dual recording sites
 (poll branch + handleComplete) for the same runId.
- Increment `droppedStaleNotices` (gate drop) and `dedupedNotices`
 (visibleControlNotices dedupe hit) as separate counters; expose both
 via `doctor.ts`. **`doctor.ts` is extended to receive `globalStore`** —
 today it has no globalStore reference, so this change adds plumbing
 (either through the existing `state` parameter or via a `globalStore`
 parameter).
- A 30-second TTL + 60-second sweep maintain the
 `recentlyTerminalRuns` map at a bounded size; `add-foreground-run-
 status-lookup` consumes it.

## Capabilities

### New Capabilities

- `subagent-control-notice`: Defines when control notices ("needs_
 attention" watchdog signals) are emitted, gated, and delivered to the
 orchestrator. Strictly live-only delivery contract; recently-terminal
 visibility is owned by the follow-up status-lookup change.

### Modified Capabilities

(none.)

## Impact

- **Code**:
 - `index.ts` — `controlEventHandler` writes to pending buffer instead
 of `pi.sendMessage`; new helper `classifyRunForNotice`; new
 `flushPendingNotices(pi, globalStore, state)`; `globalStore` keys
 for `recentlyTerminalRuns`/`droppedStaleNotices`/`dedupedNotices`/
 `pendingNotices`/sweep timer/fallback flush timer; reload cleanup
 wiring; register a NEW `pi.on("tool_result", ...)` listener that bypasses
 the existing handler's `!ctx.hasUI` guard, calling
 `flushPendingNotices` for every subagent tool result regardless of
 UI context.
 - `subagent-executor.ts` — terminal-state capture in the run finally
 block; gate inside `emitControlNotification` (lines 219 and 222 —
 both `pi.events.emit` calls) using `classifyRunForNotice`. Derives `terminalState` in `finally` from existing fields:
 catch fired → "failed"; else `result.details.results[*].interrupted` →
 "interrupted"; else `result.isError` → "failed"; else "succeeded".
 - `async-job-tracker.ts` — record terminal entry at the transition
 moment (poll branch line 136 + `handleComplete` line 182), with
 first-write-wins dedup; gate the two `pi.events.emit(...)` calls at
 lines 84/87 on liveness.
 - `subagent-runner.ts` — NO CODE CHANGES. The existing activity-timer
 state gate is sufficient; verify-only.
 - `execution.ts` — NO CODE CHANGES. The existing `processClosed ||
 settled || detached` guard at line 407 prevents event construction;
 verify-only.
 - `types.ts` — no new state fields (everything goes to `globalStore`);
 no `Details` changes (those land in change 2).
 - `doctor.ts` — plumb `globalStore` access (new function parameter
 or import); surface `droppedStaleNotices`, `dedupedNotices`,
 `recentlyTerminalRuns.size`, oldest-entry-age, `pendingNotices.size`.
- **Tests**: unit tests for `classifyRunForNotice` (live/stale matrix —
 paused-is-stale, async-job statuses), `recordTerminalRun` helper, sweep,
 cap eviction. Integration tests (in `test/integration/`): notice for a
 terminated foreground run is dropped; notice for a still-running run
 publishes; reload mid-flight does not orphan a sweep timer.
 Verification adds `npm run test:integration`.
- **Public API**: no breaking changes. `ControlConfig` shape unchanged.
- **Risk**: low. Strictly suppressive of stale notices; `paused` is
 treated as stale because the existing async-tracker schedules cleanup
 for paused runs and there is no resume API. If a paused-as-resumable
 lifecycle lands later, revisit the classifier.
