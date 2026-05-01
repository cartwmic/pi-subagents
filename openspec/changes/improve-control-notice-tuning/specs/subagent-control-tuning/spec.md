## ADDED Requirements

### Requirement: Default `needsAttentionAfterMs` SHALL be 180 seconds

`DEFAULT_CONTROL_CONFIG.needsAttentionAfterMs` SHALL be `180_000` (3 minutes). `resolveControlConfig` SHALL preserve override precedence (per-call > globalConfig > default). The threshold change is documented in CHANGELOG as BREAKING-IN-DEFAULT.

#### Scenario: Default applies when no override provided
- **WHEN** `resolveControlConfig()` is called with no arguments
- **THEN** the resolved `needsAttentionAfterMs === 180_000`

#### Scenario: Per-call override wins over default
- **WHEN** `resolveControlConfig(undefined, { needsAttentionAfterMs: 60_000 })` is called
- **THEN** the resolved `needsAttentionAfterMs === 60_000`

#### Scenario: Global config wins over default but loses to per-call
- **WHEN** `resolveControlConfig({ needsAttentionAfterMs: 90_000 }, { needsAttentionAfterMs: 30_000 })` is called
- **THEN** the resolved `needsAttentionAfterMs === 30_000`

### Requirement: `coalesceWindowMs` SHALL be a configurable buffer window

`ResolvedControlConfig` SHALL include `coalesceWindowMs: number` with default `1000`. The schema SHALL accept this field on `ControlConfig` as an optional non-negative integer; non-integer or negative values fall back to default. A value of `0` SHALL disable coalescing (each event flushes synchronously).

#### Scenario: Default coalesce window
- **WHEN** `resolveControlConfig()` is called
- **THEN** `coalesceWindowMs === 1000`

#### Scenario: Custom coalesce window honored
- **WHEN** `resolveControlConfig(undefined, { coalesceWindowMs: 1500 })` is called
- **THEN** `coalesceWindowMs === 1500`

#### Scenario: Zero disables coalescing delay; flush still goes through liveness gate
- **WHEN** `resolveControlConfig(undefined, { coalesceWindowMs: 0 })` is called
- **THEN** `coalesceWindowMs === 0`
- **AND** the orchestrator schedules `flush(runId)` to run synchronously after appending the single event to the buffer (rather than bypassing the buffer)
- **AND** the same `classifyRunForNotice` liveness gate runs at flush time, so stale notices for terminated runs are still dropped

#### Scenario: Negative falls back to default
- **WHEN** `resolveControlConfig(undefined, { coalesceWindowMs: -1 })` is called
- **THEN** `coalesceWindowMs === 1000`

#### Scenario: Non-integer falls back to default
- **WHEN** `resolveControlConfig(undefined, { coalesceWindowMs: 0.5 })` is called
- **THEN** `coalesceWindowMs === 1000`

### Requirement: `ControlEvent` SHALL gain optional `lastActivityAt` and `elapsedMs` fields

`ControlEvent` in `types.ts:61-71` SHALL include two optional fields: `lastActivityAt?: number` and `elapsedMs?: number`. `buildControlEvent` SHALL populate both when its inputs include `lastActivityAt`. The fields are additive; older `events.jsonl` records lacking these fields SHALL be tolerated (consumers default to `undefined` and recompute from `event.ts` as a last resort).

#### Scenario: buildControlEvent populates the fields
- **WHEN** `buildControlEvent({ to: "needs_attention", runId: "R", agent: "a", ts: 1000, lastActivityAt: 800 })` is called
- **THEN** the resulting event has `lastActivityAt === 800` and `elapsedMs === 200`

#### Scenario: buildControlEvent omits fields when input is absent
- **WHEN** `buildControlEvent({ to: "needs_attention", runId: "R", agent: "a", ts: 1000 })` is called (no `lastActivityAt`)
- **THEN** `lastActivityAt` and `elapsedMs` are both `undefined`

#### Scenario: Older event format is tolerated
- **WHEN** the multi-step formatter receives a `ControlEvent` with `lastActivityAt === undefined` and `elapsedMs === undefined`
- **THEN** it falls back to computing elapsed seconds from `Date.now() - event.ts` (last-resort) without throwing

### Requirement: Orchestrator SHALL coalesce per-runId notices within the configured window

The orchestrator SHALL buffer `needs_attention` events keyed by `event.runId` in `globalStore.__piSubagentControlNoticeBuffers`. On the first event for a given `runId`, a flush timer SHALL be scheduled at `coalesceWindowMs` ms from now using `setTimeout(...).unref()`. Subsequent events for the same `runId` arriving before flush SHALL accumulate into the same buffer. On flush, the orchestrator SHALL publish exactly one `subagent_control_notice` describing all events in the buffer, then delete the buffer entry.

#### Scenario: Single event flushes after window
- **WHEN** one event arrives for `runId = R`
- **AND** no further events arrive within `coalesceWindowMs`
- **THEN** one notice is published `coalesceWindowMs` ms after the event arrived

#### Scenario: Multiple sibling events coalesce into one notice
- **WHEN** events arrive for `runId = R` at times `t`, `t+50ms`, `t+200ms` with `coalesceWindowMs = 1000`
- **THEN** one notice is published at `t + 1000ms` covering all three events

#### Scenario: Different runIds do not coalesce
- **WHEN** events arrive for `runId = R1` and `runId = R2` within `coalesceWindowMs`
- **THEN** two separate notices are published, one per `runId`

#### Scenario: Window resets only between flushes
- **WHEN** an event arrives at `t`, flushes at `t + 1000ms`, and another arrives at `t + 1100ms`
- **THEN** the second event opens a new window and flushes at `t + 2100ms`

#### Scenario: `coalesceWindowMs: 0` flushes synchronously
- **WHEN** `coalesceWindowMs === 0` and an event arrives for `runId = R`
- **THEN** the orchestrator publishes a notice synchronously without scheduling a timer

### Requirement: Within-buffer SHALL dedup by `(runId, index, type)` and the synchronous path SHALL use a time-windowed `lastSeen` map

Each buffer SHALL maintain a dedup set keyed `${runId}:${index ?? 'none'}:${type}`. Events with a key already in the set SHALL be dropped from the buffer (NOT counted toward overflow). When `coalesceWindowMs === 0` (synchronous flush mode), the orchestrator SHALL consult a time-windowed `Map<string, number>` `globalStore.__piSubagentSyncFlushDedup` keyed `${runId}:${index ?? 'none'}:${type}` whose value is the `lastSeenAt` timestamp. The dedup window SHALL be `SYNC_DEDUP_WINDOW_MS = 1000`. An event whose `lastSeenAt` is within the window of the prior `lastSeenAt` for the same key SHALL be dropped; otherwise the entry's `lastSeenAt` is updated and the event proceeds.

A periodic sweep (running with the existing 60s sweep timer or its own `unref`'d interval) SHALL evict entries older than `SYNC_DEDUP_WINDOW_MS * 30` (i.e., 30 seconds), bounding the map size. Round-3 review identified that the previous `Math.floor(event.ts / 1000)` bucketing had hard boundary failures (events 998ms apart in different buckets escaped dedup) and that the unbounded Set grew across sessions.

#### Scenario: Sync-flush dedup with timestamp comparison
- **WHEN** an event arrives for `(runId: R, index: 2, type: "needs_attention")` at `ts = 1000`
- **AND** another identical-key event arrives at `ts = 1500` (500ms later)
- **THEN** the second is dropped (within `SYNC_DEDUP_WINDOW_MS = 1000`)

#### Scenario: Sync-flush dedup honors window boundary
- **WHEN** an event arrives for the same key at `ts = 1000` and another at `ts = 2050` (1050ms later)
- **THEN** both publish (outside window)

#### Scenario: Sync-flush dedup map is bounded
- **WHEN** the sweep fires after entries older than 30 seconds exist
- **THEN** those entries are removed from `__piSubagentSyncFlushDedup`

#### Scenario: Live and replay events for the same step coalesce to one bullet
- **WHEN** an event for `(runId: R, index: 2, type: "needs_attention")` arrives via the live bus
- **AND** an identical-key event arrives 100ms later from `async-job-tracker` disk replay
- **AND** both arrive before the same flush
- **THEN** the buffer holds exactly one event for that key
- **AND** the multi-step bullet list contains exactly one entry for step 3 (index+1)

#### Scenario: Distinct steps each get their own bullet
- **WHEN** events for `(runId: R, index: 1)` and `(runId: R, index: 3)` arrive in the same window
- **THEN** the buffer holds both events
- **AND** the multi-step notice has two bullets

### Requirement: `visibleControlNotices` dedup SHALL run at flush time with a per-runId flush epoch

The orchestrator SHALL NOT consult `visibleControlNotices` when an event arrives (which would suppress siblings before coalescing). Instead, the dedup check SHALL run at flush time using a per-runId flush epoch counter stored in `globalStore.__piSubagentRunFlushEpoch: Map<string, number>`. The flush key SHALL be `${runId}:epoch-${epoch}` where `epoch` is the current value (defaulting to 0). After a successful publish, the epoch SHALL be incremented (`set(runId, epoch + 1)`). This allows the same step to legitimately re-fire after recovery: each successful publish advances the epoch, so a later flush for the same step gets a new key and publishes.

#### Scenario: Receive-time check no longer suppresses siblings
- **WHEN** two events for `runId = R` arrive in the same window with the same `controlNotificationKey`
- **THEN** the buffer holds both (subject to within-buffer dedup of step keys)
- **AND** flush emits one coalesced notice covering both

#### Scenario: Flush-time dedup with per-runId flush epoch
- **WHEN** flush is called for `runId = R` with current epoch 3, producing flush-key `R:epoch-3`
- **THEN** the publish proceeds, the epoch advances to 4, and `visibleControlNotices` contains `R:epoch-3`
- **AND** a second-flush attempt that somehow re-uses the SAME epoch 3 (rare double-flush) is suppressed by `visibleControlNotices.has(R:epoch-3)`

#### Scenario: Re-stall after recovery publishes again with new epoch
- **WHEN** step 2 of run `R` stalls, flushes (epoch 0 → publishes, epoch advances to 1)
- **AND** later step 2 recovers and stalls again, accumulates a new event, flushes (epoch 1 → publishes, epoch advances to 2)
- **THEN** the user sees two notices, not one

### Requirement: Multi-step format SHALL ignore pre-built `noticeText` and render fresh

For `events.length > 1`, the flush handler SHALL render via `formatCoalescedControlNoticeMessage(events, childIntercomTargets, buffer.needsAttentionAfterMs)` and ignore every `payload.noticeText` from the buffered events. For `events.length === 1`, the flush handler SHALL prefer the pre-built `noticeText` if present (preserving byte-identical output across emitters) and fall back to `formatControlNoticeMessage(event, childIntercomTarget)` otherwise. The single-step format used at this call SHALL be the post-tuning version (with the `Action:` hint replacement applied — see hint replacement requirement).

#### Scenario: N=1 prefers pre-built noticeText
- **WHEN** exactly one event flushes for `runId = R` with a non-empty `payload.noticeText`
- **THEN** the published notice content equals that pre-built text exactly

#### Scenario: N=1 with no pre-built text uses single-step formatter
- **WHEN** exactly one event flushes with `payload.noticeText === undefined`
- **THEN** the published notice content equals `formatControlNoticeMessage(event, childIntercomTarget)` (post-hint-replacement)

#### Scenario: N=3 uses fresh multi-step formatter
- **WHEN** three events flush for `runId = R` and all three carry `payload.noticeText` strings
- **THEN** the published notice content equals `formatCoalescedControlNoticeMessage(events, childIntercomTargets, buffer.needsAttentionAfterMs)`
- **AND** the `payload.noticeText` strings are NOT used

### Requirement: Multi-step format SHALL list per-step details with per-step intercom routing preserved

`formatCoalescedControlNoticeMessage(events: ControlEvent[], childIntercomTargets: Map<number, string>, thresholdMs: number): string` SHALL produce content with: a header `Subagent needs attention: run <runId>`, a line `<N> steps stalled (>~<threshold>s no activity):`, then one bullet per event of the form ` - step <index+1> (<agent>): no activity for <elapsed>s`, then `Status:` and `Interrupt:` lines, then per-step `Nudge:` lines for steps that have a registered intercom target (one line per target, prefixed with ` step <index+1>:`), AND a single `Action:` line if any step lacks an intercom target. `<elapsed>` is computed from `event.elapsedMs / 1000` rounded down; if absent, falls back to `(now - event.ts) / 1000`. `<threshold>` is `Math.floor(thresholdMs / 1000)`. The `thresholdMs` argument is REQUIRED — the receiver captures `controlConfig.needsAttentionAfterMs` per-buffer at the first event so per-call overrides render correctly. `childIntercomTargets` is a Map keyed by `event.index` (or 0 if undefined) carrying the per-step intercom target string.

#### Scenario: Multi-step bullet format
- **WHEN** flushing 3 events with `(index: 0, agent: "a")`, `(index: 2, agent: "b")`, `(index: 4, agent: "c")` and `elapsedMs` of 195000, 187000, 192000 respectively
- **THEN** the content includes three bullets in order: ` - step 1 (a): no activity for 195s`, ` - step 3 (b): no activity for 187s`, ` - step 5 (c): no activity for 192s`

#### Scenario: Multi-step content includes Status and Interrupt commands
- **WHEN** any multi-step notice is emitted
- **THEN** the content includes `Status: subagent({ action: "status", id: "<runId>" })` and `Interrupt: subagent({ action: "interrupt", id: "<runId>" })`

#### Scenario: Per-step Nudge lines for steps with intercom
- **WHEN** a multi-step notice has 3 events `(index 0, 2, 4)` and `childIntercomTargets` contains entries for indices 0 and 2 (target strings `t0` and `t2`) but not 4
- **THEN** the content includes two `Nudge:` lines (one per intercom-routable step, prefixed with the step number) AND a single `Action:` line (because step 4 has no intercom)

#### Scenario: All steps without intercom
- **WHEN** a multi-step notice has any number of events and `childIntercomTargets.size === 0`
- **THEN** the content includes a single `Action: this run has no intercom; if it's stuck, use Interrupt above.` line and no `Nudge:` lines

#### Scenario: Elapsed fallback when fields absent
- **WHEN** an event in the buffer has `elapsedMs === undefined` and `lastActivityAt === undefined`
- **THEN** the bullet uses `Math.floor((Date.now() - event.ts) / 1000)` as the elapsed value

### Requirement: Notice hint SHALL prefer actionable Interrupt over implementation hint

When `childIntercomTarget` is undefined, the existing line `Nudge: no child message route registered` SHALL be replaced with `Action: this run has no intercom; if it's stuck, use Interrupt above.`. When `childIntercomTarget` is defined, the existing intercom `Nudge: intercom({ ... })` line SHALL be retained. This applies to both the single-step formatter and the multi-step formatter.

#### Scenario: No intercom — actionable hint shown
- **WHEN** a notice is rendered with `childIntercomTarget === undefined`
- **THEN** the notice contains `Action: this run has no intercom; if it's stuck, use Interrupt above.`
- **AND** the notice does NOT contain `Nudge: no child message route registered`

#### Scenario: Intercom available — Nudge command preserved
- **WHEN** a notice is rendered with `childIntercomTarget = "subagent-worker-abc"`
- **THEN** the notice contains `Nudge: intercom({ action: "send", to: "subagent-worker-abc", ... })`

### Requirement: Buffer SHALL store per-event payload metadata and resolved control config

Each buffer's `events` field SHALL be an `Array<{ event: ControlEvent; noticeText?: string; source?: "foreground" | "async"; asyncDir?: string }>`. The receiver SHALL stash the incoming `payload.noticeText`, `payload.source`, and `payload.asyncDir` (from `SubagentControlMessageDetails`) alongside each event. The buffer SHALL also include `needsAttentionAfterMs: number` and `coalesceWindowMs: number` captured from `payload.needsAttentionAfterMs` and `payload.coalesceWindowMs` at the first event so the multi-step formatter renders the correct threshold and the flush timer schedules at the correct delay even for runs with non-default overrides.

For this to work, the bus payload SHALL be extended at both emit sites (`subagent-executor.ts:emitControlNotification` and `async-job-tracker.ts:emitNewControlEvents`) to include `needsAttentionAfterMs: number` and `coalesceWindowMs: number` from the resolved `ControlConfig`. Older `events.jsonl` records lacking these fields SHALL fall back to the receiver's global resolved config (`loadConfig()` defaults).

#### Scenario: Buffer captures payload metadata
- **WHEN** `controlEventHandler` receives a payload with `noticeText: "..."`, `source: "foreground"`, `asyncDir: undefined`
- **THEN** the corresponding buffered entry stores `noticeText`, `source`, and `asyncDir` alongside the event

#### Scenario: Buffer captures threshold for multi-step format
- **WHEN** the first event for a buffer arrives with `controlConfig.needsAttentionAfterMs = 5_000` (override)
- **THEN** the buffer's `needsAttentionAfterMs === 5_000`
- **AND** the multi-step formatter at flush renders `(>~5s no activity)` (not the default `>~180s`)

### Requirement: Per-runId flush epoch SHALL be cleared on terminal transitions

When a run transitions to terminal (foreground delete or async transition), the orchestrator SHALL remove that runId's entry from `globalStore.__piSubagentRunFlushEpoch`. This bounds the map size: epoch entries persist only for currently-or-recently-active runs. Hook into change-1's `recordTerminalRun` (or its callers) to perform the cleanup.

#### Scenario: Epoch entry removed on terminal transition
- **WHEN** a run with id `R` transitions to terminal (foreground `recordTerminalRun` or async transition fires)
- **THEN** `globalStore.__piSubagentRunFlushEpoch.has(R) === false` after the transition

### Requirement: Emitter-side dedup SHALL clear on recovery to enable re-stall publishing

For the per-runId flush epoch (Decision 4) to actually allow re-stalls to publish, the emitter-side `emittedControlEventKeys: Set<string>` (in `execution.ts:275-281` and the analogous structure in `subagent-runner.ts:892-908`) SHALL clear the entry for `controlNotificationKey(event, target)` when the activity state transitions from `"needs_attention"` back to `undefined` (recovery). Without this, the emitter swallows the second emission of the same key, the receiver never sees the re-stall event, and the receiver's epoch counter is dead code for the re-stall case it was designed for.

#### Scenario: Recovery clears emitter dedup so re-stall publishes
- **WHEN** a step stalls (state `undefined → needs_attention`), the emitter publishes, and the dedup set contains the step's key
- **AND** the step recovers (state `needs_attention → undefined`)
- **THEN** the emitter SHALL `delete` the corresponding key from its `emittedControlEventKeys` set
- **AND** a subsequent re-stall (state `undefined → needs_attention`) SHALL publish a new event
- **AND** the receiver advances its per-runId flush epoch and publishes a new notice

#### Scenario: Epoch entry removed on terminal
- **WHEN** a run with id `R` transitions to terminal (foreground or async)
- **THEN** `globalStore.__piSubagentRunFlushEpoch.has(R) === false` after the transition

### Requirement: session_shutdown SHALL clear buffer state

The existing `session_shutdown` handler SHALL be extended to clear all `__piSubagent*` buffer/timer/lastPi state introduced by this change: `clearTimeout` every `flushTimer` in `__piSubagentControlNoticeBuffers`, delete all entries, clear `__piSubagentSyncFlushDedup`, clear `__piSubagentRunFlushEpoch`, and unset `__piSubagentLastPi`. No `pi.sendMessage` SHALL be called during shutdown.

#### Scenario: Shutdown clears state without ghost notices
- **WHEN** `session_shutdown` fires with a non-empty buffer holding a pending `flushTimer`
- **THEN** `clearTimeout` is called, the buffer is empty, and no `pi.sendMessage` is invoked during or after shutdown

### Requirement: Coalesce buffer SHALL be size-capped with overflow counter

Each per-runId buffer SHALL accept at most 100 events. Events arriving when the buffer is full SHALL be dropped (without entering the buffer); `globalStore.__piSubagentDroppedCoalesceOverflow` SHALL increment for each drop. Overflow drops SHALL NOT prevent the buffer from flushing on schedule. The counter SHALL be readable from `doctor.ts` output alongside the change-1 control-notice metrics.

#### Scenario: 100 events accumulate normally
- **WHEN** 100 events arrive for `runId = R` within `coalesceWindowMs` (each with distinct dedup keys)
- **THEN** all 100 are present in the flushed notice
- **AND** `globalStore.__piSubagentDroppedCoalesceOverflow === 0`

#### Scenario: 101st event is dropped
- **WHEN** a 101st event arrives with a distinct dedup key
- **THEN** the buffer holds 100 events
- **AND** `globalStore.__piSubagentDroppedCoalesceOverflow === 1`
- **AND** the flush still fires at the originally scheduled time

#### Scenario: Doctor surfaces overflow
- **WHEN** `doctor` is invoked
- **THEN** the output includes the value of `__piSubagentDroppedCoalesceOverflow`

### Requirement: Renderer SHALL handle multi-step notices

`SubagentControlMessageDetails` SHALL gain an optional `events?: ControlEvent[]` field. `SubagentControlNoticeComponent.render` SHALL inspect `events?.length`. When `events.length > 1`, the rendered header SHALL read `Subagent needs attention: run <runId> (<N> steps)`. When `events.length <= 1`, the rendered header SHALL be the existing single-event form `Subagent needs attention: <agent>`.

#### Scenario: Multi-step header reflects run-level scope
- **WHEN** a multi-step notice with `events.length === 3` for `runId = "abc"` is rendered
- **THEN** the box header reads `⚠ Subagent needs attention: run abc (3 steps)` (truncated to width as today)

#### Scenario: Single-step header preserved
- **WHEN** a single-step notice is rendered (events.length === 1 or undefined)
- **THEN** the header form is unchanged from before this change

### Requirement: Coalesce buffers SHALL be dropped on reload (no flush via stale `pi`)

The buffer map SHALL live in `globalStore.__piSubagentControlNoticeBuffers`. When `previousRuntimeCleanup` runs (extension reload), the cleanup SHALL `clearTimeout` every `flushTimer` and DELETE all buffer entries WITHOUT calling `pi.sendMessage`. Increment `globalStore.__piSubagentDroppedStaleNotices` by the count dropped. `globalStore.__piSubagentLastPi` SHALL be set ONCE at the registration AFTER `previousRuntimeCleanup` runs, so the prior registration's drop never sees the new `pi`. The new instance starts with an empty buffer.

**Tradeoff:** A pending coalesced notice for a stalled step is lost permanently UNLESS the step recovers and re-stalls (because the runner-side activity state is preserved across receiver reload — the runner doesn't reload — so `shouldEmitControlEvent` doesn't fire again until a state transition). For genuinely-stuck zombie runs this means: reload during stall → no further notification until the user manually inspects via `subagent({action:"status"})` or the run terminates. This is acceptable because reload is rare and the change-1 delivery-time gate already drops post-completion notices. CHANGELOG documents this loss explicitly.

#### Scenario: Reload drops pending coalesced notices
- **WHEN** a buffer holds 2 events for `runId = R` and `previousRuntimeCleanup` runs
- **THEN** `clearTimeout(buffer.flushTimer)` is called, the buffer entry is deleted, and `__piSubagentDroppedStaleNotices` increments by 2
- **AND** `pi.sendMessage` is NOT called from the cleanup

#### Scenario: New `pi` reference is set after cleanup
- **WHEN** `registerSubagentExtension(pi)` runs
- **THEN** the order is: (1) `previousRuntimeCleanup()` (which uses no `pi`), (2) `globalStore.__piSubagentLastPi = pi`, (3) install handlers

(See scenarios under the reload-drop requirement above.)

### Requirement: Documentation SHALL describe the watchdog tuning surface

The repository `README.md` SHALL include a section titled `## Tuning the watchdog` covering `needsAttentionAfterMs`, `coalesceWindowMs`, `notifyOn`, and `notifyChannels` with example invocations. The section SHALL include a "Restoring the 60s threshold" snippet for users migrating. `skills/pi-subagents/SKILL.md` SHALL gain a "Reading control notices" sub-section covering: (a) prefer `Interrupt` over `Status` for parallel-tasks runs without intercom; (b) wait at least one `coalesceWindowMs` before status-checking after a notice arrives.

#### Scenario: README section exists
- **WHEN** the repository is checked out at the version that ships this change
- **THEN** `README.md` contains the heading `## Tuning the watchdog` exactly
- **AND** the section names all four config fields above

#### Scenario: README contains migration snippet
- **WHEN** the README is parsed
- **THEN** the section contains a code snippet showing `subagent({ task: "...", control: { needsAttentionAfterMs: 60_000 } })` (or equivalent global-config form)

#### Scenario: SKILL.md guidance updated
- **WHEN** an agent loads `skills/pi-subagents/SKILL.md`
- **THEN** the file contains a sub-section titled `Reading control notices` (exact heading)
- **AND** the sub-section names `Interrupt` as the typical action for parallel-tasks runs without intercom
