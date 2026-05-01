# subagent-control-notice Specification

## Purpose
TBD - created by archiving change fix-control-notice-liveness-gate. Update Purpose after archive.
## Requirements
### Requirement: Control notices SHALL be dropped when the referenced run is not live

The orchestrator SHALL drop a `needs_attention` control event when `classifyRunForNotice(state, event.runId)` returns `"stale"`. The classifier returns `"live"` iff the runId is present in `state.foregroundControls` OR the runId is present in `state.asyncJobs` with `status` in the set `{queued, running}`. All other cases — including `paused` async runs and runIds present in `recentlyTerminalRuns` — SHALL classify as `"stale"`. Drop happens at delivery time (see flush requirement) for receiver-path notices, and at emit time for bus-emit gates.

#### Scenario: Notice for a foreground-active run is delivered
- **WHEN** a `needs_attention` event arrives with `runId = R` and `state.foregroundControls.has(R)` is true
- **THEN** the orchestrator publishes a `subagent_control_notice` message via `pi.sendMessage(..., { triggerTurn: true })`

#### Scenario: Notice for a running async run is delivered
- **WHEN** a `needs_attention` event arrives with `runId = R` and `state.asyncJobs.get(R)?.status === "running"`
- **THEN** the orchestrator publishes a `subagent_control_notice` message

#### Scenario: Notice for a paused async run is dropped
- **WHEN** a `needs_attention` event arrives with `runId = R` and `state.asyncJobs.get(R)?.status === "paused"`
- **THEN** the orchestrator drops the notice (paused is on the cleanup path; current code does not support paused-as-resumable)
- **AND** `globalStore.droppedStaleNotices` increments by 1

#### Scenario: Notice for a queued async run is delivered
- **WHEN** a `needs_attention` event arrives with `runId = R` and `state.asyncJobs.get(R)?.status === "queued"`
- **THEN** the orchestrator publishes a `subagent_control_notice` message

#### Scenario: Notice for a terminal-state async run is dropped
- **WHEN** a `needs_attention` event arrives with `runId = R` and `state.asyncJobs.get(R)?.status` is `"complete"` or `"failed"`
- **THEN** no `subagent_control_notice` is published
- **AND** `globalStore.droppedStaleNotices` increments by 1

#### Scenario: Notice for an unknown runId is dropped
- **WHEN** a `needs_attention` event arrives with `runId = R` that is in NEITHER `state.foregroundControls` NOR `state.asyncJobs`
- **THEN** no `subagent_control_notice` is published
- **AND** `globalStore.droppedStaleNotices` increments by 1
- **AND** even if `R` exists in `recentlyTerminalRuns`, the notice is still dropped (recently-terminal entries do not gate delivery in this change)

### Requirement: Run finalization SHALL record the terminal entry with first-write-wins semantics

The executor SHALL record the terminal entry in `globalStore.__piSubagentRecentlyTerminalRuns` at run finalization. For foreground runs, this means `recordTerminalRun(globalStore, runId, terminalState)` SHALL be called in the same `finally` block as `state.foregroundControls.delete(runId)` (`subagent-executor.ts:1862-1888`). For async runs, recording SHALL happen at the transition moment (`async-job-tracker.ts:136` and `:182`), NOT at `scheduleCleanup` / `asyncJobs.delete` time. The strict ordering of record-before-delete is asserted and exercised by `add-foreground-run-status-lookup` (which consumes the map for status responses); this change does not require ordering for its own gate (Decision 1: recently-terminal is not consulted by the gate).

The recorded entry SHALL contain `terminatedAt: number` and `terminalState` ∈ `{"succeeded", "failed", "interrupted"}`. For foreground runs, `terminalState` SHALL be derived in `finally` from the captured execution result (`AgentToolResult<Details>`) and the catch path:

1. If the outer `catch` ran, `terminalState = "failed"`.
2. Otherwise, inspect `executionResult.details.results` (each is a `SingleResult` per `types.ts:156`): if any has `interrupted === true`, `terminalState = "interrupted"`.
3. Otherwise, if `executionResult.isError === true`, `terminalState = "failed"`.
4. Otherwise `terminalState = "succeeded"`.

This sequence reads only existing fields populated by `execution.ts` and `subagent-runner.ts` — no listener is attached to `foregroundControl.interrupt` (which is a `() => boolean` callback reassigned mid-flight, not an `AbortController`). For async runs, `complete` maps to `"succeeded"` and `failed` maps to `"failed"`.

`recordTerminalRun` SHALL be **first-write-wins**: if `recentlyTerminalRuns.has(runId)` already, the function SHALL return without modifying the existing entry. This dedupes the dual recording sites in `async-job-tracker.ts` (poll branch + handleComplete) for the same runId.

#### Scenario: Foreground run that returns normally
- **WHEN** a foreground run with `runId = R` returns a non-error `AgentToolResult`
- **THEN** before `foregroundControls.delete(R)` runs, `recentlyTerminalRuns.get(R)` exists with `terminalState === "succeeded"`

#### Scenario: Foreground run that throws
- **WHEN** a foreground run with `runId = R` throws inside the try block
- **THEN** `recentlyTerminalRuns.get(R)` exists with `terminalState === "failed"` after `finally` runs

#### Scenario: Foreground run that returns isError:true
- **WHEN** a foreground run with `runId = R` returns an `AgentToolResult` whose `isError === true` without throwing
- **THEN** `recentlyTerminalRuns.get(R)` exists with `terminalState === "failed"`

#### Scenario: Foreground run that is interrupted via SingleResult.interrupted
- **WHEN** a foreground run with `runId = R` returns an `executionResult` whose `details.results` contains at least one `SingleResult` with `interrupted === true`, AND the outer `catch` did not fire
- **THEN** `recentlyTerminalRuns.get(R)` exists with `terminalState === "interrupted"`

#### Scenario: First-write-wins for async dual-record
- **WHEN** `recordTerminalRun(globalStore, R, "succeeded")` is called twice in succession (e.g., poll branch and handleComplete both fire for the same id)
- **THEN** the second call returns without modifying the entry; `terminatedAt` reflects the first call's timestamp

#### Scenario: Async run transitions complete in poll branch
- **WHEN** the async-job-tracker poll observes `previousStatus !== "complete"` and `job.status === "complete"`
- **THEN** `recentlyTerminalRuns.get(job.asyncId)` exists with `terminalState === "succeeded"` BEFORE `scheduleCleanup` is called

#### Scenario: Async run transitions failed in poll branch
- **WHEN** the async-job-tracker poll observes `previousStatus !== "failed"` and `job.status === "failed"`
- **THEN** `recentlyTerminalRuns.get(job.asyncId)` exists with `terminalState === "failed"`

#### Scenario: Async run paused does not produce a terminal entry directly
- **WHEN** the async-job-tracker poll observes `job.status === "paused"`
- **THEN** `recentlyTerminalRuns.get(job.asyncId)` is undefined (until and unless the job later transitions to `complete` or `failed`)

### Requirement: Recently-terminal entries SHALL expire on a TTL sweep

`globalStore.recentlyTerminalRuns` SHALL retain entries for a TTL of 30 seconds, swept by an interval timer (60 seconds) registered with `unref()` at extension load. The map SHALL cap at 1000 entries; on overflow during insert, the oldest entry by `terminatedAt` SHALL be evicted. The sweep timer handle SHALL be stored in `globalStore.__piSubagentSweepTimer` and SHALL be `clearInterval`'d on extension reload before installing a new sweep.

#### Scenario: Entry survives within TTL
- **WHEN** an entry is recorded with `terminatedAt = now`
- **AND** `now + 25_000` ms elapses without sweep firing
- **THEN** the entry is still present in `recentlyTerminalRuns`

#### Scenario: Entry removed after sweep past TTL
- **WHEN** an entry was recorded `40_000` ms ago and the sweep fires
- **THEN** the entry is removed from `recentlyTerminalRuns`

#### Scenario: Map cap eviction by oldest terminatedAt
- **WHEN** the map already holds 1000 entries and a 1001st `recordTerminalRun` is called
- **THEN** the entry with the oldest `terminatedAt` SHALL be removed and the new entry SHALL be inserted, leaving the map size at 1000

#### Scenario: Sweep timer is reload-safe
- **WHEN** `registerSubagentExtension` is called a second time (reload)
- **THEN** the prior sweep timer (stored in `globalStore.__piSubagentSweepTimer`) is cleared before a new one is installed

### Requirement: Bus-emit sites SHALL gate on liveness; derive-state guards SHALL be preserved

Four bus-emit sites SHALL gate their `pi.events.emit(...)` calls on `classifyRunForNotice(state, runId)` returning `"live"`:

1. `subagent-executor.ts:219` — `pi.events.emit(SUBAGENT_CONTROL_EVENT, payload)`.
2. `subagent-executor.ts:222` — `pi.events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, ...)`.
3. `async-job-tracker.ts:84` — `pi.events.emit(SUBAGENT_CONTROL_EVENT, payload)`.
4. `async-job-tracker.ts:87` — `pi.events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, ...)`.

At each site, prepend `if (classifyRunForNotice(state, runId) === "stale") return;`. The classifier signature does NOT take `globalStore` (the gate doesn't consult recently-terminal entries); it imports `state` from the calling context. The async-tracker bus-emit gate at sites 3 and 4 SHALL also benefit from a poll-order reorder (Decision 9): `readStatus(job.asyncDir)` and `job.status` update happen BEFORE `emitNewControlEvents(job)` so the gate's view of `state.asyncJobs[runId].status` is current.

Two pre-existing **derive-state guards** SHALL be preserved unchanged (they prevent event construction, not bus emission):

- `execution.ts:407` — `if (processClosed || settled || detached) return;` in the activity-timer callback.
- `subagent-runner.ts:946` — `if (statusPayload.state !== "running") return;` in the runner's activity timer.

These two are not bus-emit gates; they are correctness invariants for the `updateActivityState` derivation step. Verify-only in tests; no new code in `execution.ts` or `subagent-runner.ts`.

#### Scenario: Foreground intercom-channel notice is gated
- **WHEN** `emitControlNotification` is called for a runId whose foreground entry has been deleted and whose async entry is `complete`
- **THEN** neither `SUBAGENT_CONTROL_EVENT` nor `SUBAGENT_CONTROL_INTERCOM_EVENT` is emitted

#### Scenario: Async-tracker disk-replay events are gated
- **WHEN** `emitNewControlEvents` reads a `needs_attention` line from `events.jsonl` for a runId now in terminal state
- **THEN** neither `SUBAGENT_CONTROL_EVENT` nor `SUBAGENT_CONTROL_INTERCOM_EVENT` is emitted by lines 84/87

#### Scenario: Live runs still emit
- **WHEN** any of the five emit sites fires for a runId classified as `"live"`
- **THEN** the corresponding `pi.events.emit` IS called as before

### Requirement: Notices SHALL be deferred via a pending-notices buffer until flush-time liveness re-check

`controlEventHandler` SHALL NOT call `pi.sendMessage` directly. Instead, on a live-classified event, it SHALL write the notice payload into `globalStore.__piSubagentPendingNotices: Map<string, { arrivedAt: number; payload: SubagentControlMessageDetails; runId: string }>` keyed by the existing dedup key. `flushPendingNotices(pi, globalStore, state)` SHALL be invoked from two trigger sites: (a) the existing `pi.on("tool_result", ...)` registration in `index.ts:519` for `event.toolName === "subagent"`; (b) a fallback `setInterval(() => flushPendingNotices(...), 5_000).unref()` registered at extension load. At flush, each entry SHALL be re-checked via `classifyRunForNotice`; live entries publish via `pi.sendMessage` and are removed from the buffer; stale entries increment `globalStore.droppedStaleNotices` and are removed without publishing.

#### Scenario: Notice arrives while live, run terminates before flush
- **WHEN** `controlEventHandler` writes a notice to the pending buffer for `runId = R` (R is live)
- **AND** `R` terminates (via foreground delete or async transition) before any flush trigger fires
- **AND** then a flush trigger fires (either `tool_result` for the subagent tool or the 5s fallback)
- **THEN** the flush re-checks `classifyRunForNotice` and classifies as stale
- **AND** the notice is dropped (no `pi.sendMessage` call) and `droppedStaleNotices` increments

#### Scenario: Notice arrives while live, run still live at flush
- **WHEN** `controlEventHandler` writes a notice for live `runId = R`
- **AND** `R` is still live at flush time
- **THEN** the flush calls `pi.sendMessage` with the saved payload, adds the dedup key to `visibleControlNotices`, and removes the entry from the buffer

#### Scenario: Tool-result hook flushes after subagent tool returns
- **WHEN** the parent's `subagent` tool returns and `pi.on("tool_result", ...)` fires for `event.toolName === "subagent"`
- **THEN** `flushPendingNotices` is invoked for ALL pending entries (not just for the runId of the returned tool)

#### Scenario: Fallback timer flushes when no tool_result fires
- **WHEN** a notice has been pending for >5 seconds without a `tool_result` trigger
- **THEN** the fallback timer flushes the entry through the same re-check path

#### Scenario: Pending buffer is dropped on reload (not flushed via stale pi)
- **WHEN** `previousRuntimeCleanup` runs (extension reload)
- **THEN** the cleanup deletes all entries from the pending buffer WITHOUT calling `pi.sendMessage`
- **AND** `globalStore.droppedStaleNotices` increments by the number of entries dropped

### Requirement: Dropped stale notices SHALL NOT poison the dedupe set

When the receiver gate drops a `"stale"` notice, the orchestrator SHALL NOT call `globalStore.visibleControlNotices.add(key)`. The dedupe set SHALL remain unchanged so a later legitimate live recurrence with the same `controlNotificationKey` is not silently suppressed.

#### Scenario: Drop does not pollute dedupe set
- **WHEN** a stale notice arrives with `key = K` and the gate drops it
- **THEN** `globalStore.visibleControlNotices.has(K)` is the same value before and after the drop

#### Scenario: Subsequent live recurrence with same key still publishes
- **GIVEN** a stale notice for `key = K` was dropped
- **WHEN** a subsequent legitimate `needs_attention` event with the same key arrives, classified `"live"`, and `K` was not previously in `visibleControlNotices`
- **THEN** the orchestrator publishes a `subagent_control_notice` message and adds `K` to `visibleControlNotices`

### Requirement: Dropped and deduped counters SHALL be exposed via doctor

`globalStore.droppedStaleNotices: number` and `globalStore.dedupedNotices: number` SHALL be process-lifetime counters. `droppedStaleNotices` increments on every gate drop. `dedupedNotices` increments on every `visibleControlNotices` hit (where a notice is suppressed because the key was already seen). Both counters SHALL be readable from `doctor.ts` output, alongside `recentlyTerminalRuns.size`, the oldest `terminatedAt` age in seconds, and `pendingNotices.size`.

#### Scenario: Drop counter increments
- **WHEN** the gate drops a stale notice
- **THEN** `droppedStaleNotices` increments by exactly 1
- **AND** `dedupedNotices` is unchanged

#### Scenario: Dedupe counter increments
- **WHEN** the dedupe set already contains the notice key and the orchestrator suppresses
- **THEN** `dedupedNotices` increments by exactly 1
- **AND** `droppedStaleNotices` is unchanged

#### Scenario: Doctor surfaces all four metrics
- **WHEN** `doctor` is invoked
- **THEN** the output includes `droppedStaleNotices`, `dedupedNotices`, `recentlyTerminalRuns.size`, oldest-entry-age (or "(empty)" if size is 0), and `pendingNotices.size`

### Requirement: All new state SHALL live in `globalStore` under documented keys

The orchestrator SHALL use the following `globalStore` keys, all mounted directly on the global store object (NOT under nested objects). `add-foreground-run-status-lookup` and `improve-control-notice-tuning` reference these exact keys:

- `__piSubagentRecentlyTerminalRuns: Map<string, { terminatedAt: number; terminalState: "succeeded" | "failed" | "interrupted" }>`
- `__piSubagentDroppedStaleNotices: number`
- `__piSubagentDedupedNotices: number`
- `__piSubagentPendingNotices: Map<string, { arrivedAt: number; payload: SubagentControlMessageDetails; runId: string }>`
- `__piSubagentSweepTimer: NodeJS.Timeout | undefined`
- `__piSubagentFlushFallbackTimer: NodeJS.Timeout | undefined`

None of these SHALL be added to `SubagentState`. All keys are initialized lazily on first access (Map / 0 / undefined defaults). Cross-change references (e.g., `add-foreground-run-status-lookup` reading `__piSubagentRecentlyTerminalRuns`) SHALL use the same exact key names.

#### Scenario: State survives extension reload
- **WHEN** the extension is reloaded (i.e., `registerSubagentExtension` is invoked a second time after a `previousRuntimeCleanup` cycle)
- **THEN** all four `globalStore` entries persist across the reload (the map and counters are not reinitialized)
- **AND** the previously-installed sweep timer is replaced (cleared, then a new one installed) without leaving the prior interval running

#### Scenario: SubagentState contains no new fields
- **WHEN** the extension's `SubagentState` is constructed
- **THEN** it contains the same fields as before this change (no `recentlyTerminalRuns`, no `droppedStaleNotices`, no `dedupedNotices`)

