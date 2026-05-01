## Context

The control-notice mechanism surfaces stuck/zombie subagent runs to the
orchestrator. Implementation today is split across:

- `subagent-control.ts` — pure helpers (`deriveActivityState`,
  `shouldEmitControlEvent`, `claimControlNotification`,
  `formatControlNoticeMessage`).
- `execution.ts` — single-run executor; runs a 1-second `activityTimer`
  that calls `updateActivityState`, which calls `emitControlEvent`.
  Already gates the timer callback on `processClosed || settled ||
  detached` (line 407).
- `subagent-runner.ts` — separately spawned process for parallel/async
  runs. Its activity timer (line 946) writes events to disk via
  `appendControlEvent`. Its lifecycle flag is `statusPayload.state`,
  with values from `{queued, running, complete, failed, paused}`. There
  is no `processClosed`/`settled`/`detached` in scope. For this change's
  liveness gate, only `{queued, running}` count as live; `paused`,
  `complete`, and `failed` all classify as stale.
- `subagent-executor.ts:emitControlNotification` (line 202) — the
  *real* event-bus emit site for foreground runs. Emits
  `SUBAGENT_CONTROL_EVENT` and (when intercom is active)
  `SUBAGENT_CONTROL_INTERCOM_EVENT`.
- `async-job-tracker.ts:84` and `:87` — the async replay path. Emits
  the same two events for control records read from disk after the
  subagent process has already terminated.
- `index.ts:controlEventHandler` (line ~492) — receives
  `SUBAGENT_CONTROL_EVENT`, dedupes via the `visibleControlNotices` set
  stored in `globalStore`, and `pi.sendMessage(..., { triggerTurn: true
  })`.

The user-visible bug: in a parallel batch, the receiver-side emit
arrives buffered behind the parent's tool call. By the time the parent
processes it, all children have completed, the parent run has been
removed from `state.foregroundControls`, and the chase to
`subagent({action:"status", id})` returns "Async run not found." The
notice is a false alarm.

## Goals / Non-Goals

**Goals:**

- A control notice is delivered to the parent only when its run is
  still live. "Live" means present in `state.foregroundControls` OR
  present in `state.asyncJobs` with status in `{queued, running,
  paused}`.
- Recently-terminal data plumbing is introduced (a `Map<runId,
  {terminatedAt, terminalState}>`), but is **not consulted** by the
  gate in this change. It exists for `add-foreground-run-status-lookup`
  to make `action:"status"` answer usefully for runs that just ended.
- Both emit-side and receiver-side gates are present, covering all five
  emit sites (subagent-executor.ts × 2 channels, async-job-tracker.ts ×
  2 channels, plus the existing execution.ts timer guard).
- All new in-memory state survives `ctx.reload()` by living in
  `globalStore`.
- Live-run behavior is unchanged.

**Non-Goals:**

- Delivering "you can ignore this, it just ended" notices within a TTL.
  That requires updating `formatControlNoticeMessage` and the renderer
  in ways out of scope here. If we need it, it lands as a follow-up.
- Coalescing parallel-sibling notices into one (separate change).
- Changing `action:"status"` lookup to consult foreground or
  recently-terminal entries. Owned by `add-foreground-run-status-
  lookup`.
- Bumping default `needsAttentionAfterMs` (separate change).

## Decisions

### Decision 1: Strict live-only gate; no within-TTL delivery

**Choice:** `classifyRunForNotice(state, runId)` returns
`"live"` iff:

1. `state.foregroundControls.has(runId)`, OR
2. `state.asyncJobs.get(runId)?.status` ∈ `{queued, running}`.

All other cases — including `paused` and entries in
`recentlyTerminalRuns` — return `"stale"`. The gate drops every `"stale"`
notice.

**Why `paused` is stale, not live:** Round 2 review correctly noted
that the current code does not support paused-as-resumable: the async
tracker schedules cleanup for `paused` (`async-job-tracker.ts:136-137`),
the `interrupt` action only targets `running` jobs with a live pid, and
there is no `resume` API surfaced through the tool. Treating `paused`
as live would suppress notices for jobs already on a cleanup path.
If paused-as-resumable lifecycle lands as a separate change, this
classifier should be revisited.

**Why strict drop:** The user's bug had notices arriving after the
parallel run finished. A 30s TTL "deliver-with-hint" would not have
suppressed those — the parent would still be told to call a `Status:`
command that returns "Async run not found." Strict drop is the simplest
fix that achieves the success criterion.

### Decision 2: Three-layer gate — emit, delivery, and existing derive-state

**Choice:** Three independent layers, each catching a different race:

- **Layer A — Derive-state guards (existing, verify-only):**
  - `execution.ts:407`: `if (processClosed || settled || detached)
    return;`. Prevents `updateActivityState` from running after
    process termination begins. NOT a bus-emit site — it stops the
    event from being constructed at all.
  - `subagent-runner.ts:946`: `if (statusPayload.state !== "running")
    return;`. Same role on the runner side. NOT a bus-emit site.
  These existing guards are kept as-is. No new code.

- **Layer B — Bus-emit gates (NEW, four sites total):**
  1. `subagent-executor.ts:219` —
     `pi.events.emit(SUBAGENT_CONTROL_EVENT, payload)`.
  2. `subagent-executor.ts:222` —
     `pi.events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, ...)`.
  3. `async-job-tracker.ts:84` —
     `pi.events.emit(SUBAGENT_CONTROL_EVENT, payload)`.
  4. `async-job-tracker.ts:87` —
     `pi.events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, ...)`.
  At each site, add `if (classifyRunForNotice(state, runId) === "stale") return;` before the emit. This catches the
  case where the watchdog *did* construct an event (passed Layer A)
  but the run terminated between construction and emit.

- **Layer C — Delivery-time gate (NEW):** This is the layer that
  actually fixes the user-visible false-alarm bug. See Decision 3.

**Why three layers:** Round-2 review correctly identified that the
receiver-side gate alone is insufficient because `pi.sendMessage`
queues messages for the parent's next turn — and during a long
parent tool call (a parallel batch), the run can become stale
between `controlEventHandler` execution and the parent processing
the notice. Layer C catches this critical case.

### Decision 3: Delivery-time gate via deferred pending-notices buffer

**Choice:** `controlEventHandler` does NOT call `pi.sendMessage`
directly. Instead, on a live-classified event:

1. Build the `noticeText` payload as before.
2. Write to `globalStore.__piSubagentPendingNotices` keyed by
   `${runId}:${index ?? 'none'}:${type}`. Entry shape:
   `{ arrivedAt: number; payload: SubagentControlMessageDetails;
     runId: string; }`.
3. Schedule a flush via existing hooks (no new sendMessage call yet).

`flushPendingNotices(pi, globalStore, state)` walks the buffer:
- For each entry, re-check `classifyRunForNotice(state, entry.runId)`.
- If `"live"`: call `pi.sendMessage(...)` with the saved payload, add
  the dedup key to `visibleControlNotices`, remove from buffer.
- If `"stale"`: increment `droppedStaleNotices`, remove from buffer.
- Optionally: drop entries older than 60s regardless (TTL on the
  pending buffer itself).

**Flush triggers (two):**

1. **`pi.on("tool_result", ctx)` hook** — A NEW listener (separate
   from the existing `index.ts:519` handler, which early-returns on
   `!ctx.hasUI`) calls `flushPendingNotices` for every subagent tool
   result regardless of UI context, ensuring headless sessions flush
   too. Rationale: a subagent tool
   result means the parent's tool call just returned; this is exactly
   the moment the bug surfaces (run completed, notice waiting). The
   flush re-checks and drops stale entries before they would have
   become visible.
2. **Fallback timer** — `setInterval(() => flushPendingNotices(...),
   5_000).unref()`. Catches notices for async runs that complete
   without a parent `tool_result` (e.g., when no parallel parent
   exists). 5 seconds gives a good upper bound on parent-visible
   latency for genuinely-live notices, while still catching most
   stale-by-now cases.

**Why the hook AND a fallback:** Hook alone misses runs that complete
between parent tool calls. Fallback alone adds 5s latency to every
notice, which is annoying for genuinely-live runs that should be seen
immediately. Together: the hook flushes promptly when there's signal,
the fallback prevents starvation.

**Reload safety:** The pending buffer lives in `globalStore`; on
reload, `runtimeCleanup` walks the buffer and DELETES all entries
without calling `pi.sendMessage` (the prior closure's `pi` is
mid-teardown). `droppedStaleNotices` is incremented by the count
dropped. See Decision 8.

**Alternative considered:** Inline `setImmediate(...)` defer in
`controlEventHandler`. Rejected — doesn't actually wait long enough
to observe the run terminating; the run is still live when
`setImmediate` fires.

**Alternative considered:** Block on the parent's idle state via some
`pi.idle()` API. Rejected — no such API exists; would require pi
harness changes.

### Decision 4: Record terminal transitions at the transition moment

**Choice:** Three recording sites; capture `terminalState` at each.

- **Foreground (`subagent-executor.ts:1862–1888`)**: Introduce a
  closure variable `terminalState: "succeeded" | "failed" |
  "interrupted" = "succeeded";` AND capture the returned result
  reference: `let executionResult: AgentToolResult<Details> |
  undefined`. In the outer `catch`, set `terminalState = "failed"`. In
  the try-return path, save `executionResult = await
  runSinglePath/...`. In `finally`, derive the final `terminalState`:
  1. If outer `catch` already set `"failed"`, keep it.
  2. Otherwise, inspect `executionResult.details.results` (each is a
     `SingleResult` per `types.ts:156`): if any has
     `result.interrupted === true`, set `"interrupted"`.
  3. Otherwise, if `executionResult.isError === true`, set `"failed"`.
  4. Otherwise leave as `"succeeded"`.
  Then call `recordTerminalRun(globalStore, runId, terminalState)`
  BEFORE `state.foregroundControls.delete(runId)`.

  **Why `result.interrupted` and not a listener:** Round-3 review
  verified that `foregroundControl.interrupt` is a `() => boolean`
  callback (`types.ts:299`) that the executor reassigns mid-flight
  (`subagent-executor.ts:988, 1052, 1499, 1549`). There is no stable
  target to listen to. The run paths in `execution.ts` and
  `subagent-runner.ts` already populate `SingleResult.interrupted`
  (`types.ts:156`) when a step ends due to interrupt; reading it from
  the returned result is the only race-free, side-effect-free
  signal.
- **Async tracker poll branch (`async-job-tracker.ts:136`)**: At the
  branch where `(job.status === "complete" || job.status === "failed")
  && previousStatus !== job.status`, call
  `recordTerminalRun(globalStore, job.asyncId, mapStatus(job.status))`.
  `mapStatus`: `complete → succeeded`, `failed → failed`. `paused` is
  excluded from terminal recording. The gate already classifies `paused`
  as stale, so no recording is needed for the gate's purpose. The
  cleanup-on-paused path eventually transitions to `complete`/`failed`,
  which IS recorded.
- **Async tracker handleComplete (`async-job-tracker.ts:182`)**: Same
  call, before `scheduleCleanup(asyncId)`.
- **First-write-wins idempotence:** `recordTerminalRun` checks
  `recentlyTerminalRuns.has(runId)` and returns early if present —
  preserving the earliest `terminatedAt`. This handles the case where
  both the poll branch and `handleComplete` would record for the same
  runId.

**Why not at `scheduleCleanup`/`asyncJobs.delete`:** Those run on a
10-second timer in `async-job-tracker.ts:33-39`. A notice arriving
between transition and delete would find the asyncJob in non-running
state but the recently-terminal map empty — exactly the race the gate
was supposed to close.

### Decision 4b: `liveness.ts` module owns the gate's globalStore alias

**Choice:** New module `liveness.ts` exports `setLivenessGlobals(globalStore)` (called once from `registerSubagentExtension` before installing event handlers) plus `classifyRunForNotice(state, runId)`. The classifier does NOT consult `globalStore` because recently-terminal entries are not used by the gate (Decision 1). The module-scope alias serves `recordTerminalRun`/`sweepRecentTerminalRuns` helpers.

**Why a module:** Round-3 review correctly noted that threading `globalStore` through `EmitControlNotificationInput`, `createForegroundControlNotifier`, `createAsyncJobTracker` deps is materially invasive. A module-scope alias keeps the global reference in one file with a single initialization point.

### Decision 5: All new state lives in `globalStore`

**Choice:** Store `recentlyTerminalRuns`, `droppedStaleNotices`,
`dedupedNotices`, `pendingNotices`, and the sweep timer handle in `globalStore` under
new keys (`__piSubagentRecentlyTerminalRuns`,
`__piSubagentDroppedStaleNotices`, `__piSubagentDedupedNotices`,
`__piSubagentPendingNotices`, `__piSubagentSweepTimer`,
`__piSubagentFlushFallbackTimer`). Do NOT add fields to `SubagentState`.

**Why:** Source-requirements: "new in-memory state must survive
`ctx.reload()` patterns." `state` is recreated on registration; only
`globalStore` survives. The existing pattern already uses globalStore
keys for `visibleControlNotices` (`controlNoticeSeenStoreKey`) and
unsubscribes. We follow that pattern.

**Reload cleanup wiring:** At the top of
`registerSubagentExtension`, after the existing `previousRuntimeCleanup`
section, also `clearInterval(globalStore[__piSubagentSweepTimer])` if
present, then install a new sweep. Add the sweep clear to
`runtimeCleanup` so an explicit reload sweep also clears it.

### Decision 6: Dropped notices DO NOT poison the dedupe set

**Choice:** When the receiver gate drops a stale notice, do not call
`visibleControlNotices.add(key)`. Increment `droppedStaleNotices`
instead.

**Why:** `controlNotificationKey` is `${childKey}:${type}`. If a
dropped key were added, a later legitimate live recurrence with the
same key (rare in practice — `shouldEmitControlEvent` only fires on
state transitions — but possible across reloads or async replays)
would also be dropped, silently. This converts a should-be-visible
event to invisible. Two reviewers flagged this.

**Tradeoff:** A pathological flood of stale events for the same key
will not be deduped — every event will hit the gate and increment the
counter. The counter itself becomes the rate signal.

### Decision 7: Spec scenario for TTL expiry references the runtime check, not the sweep

**Choice:** Spec scenario "Entry expires past TTL" wording: "WHEN a
notice arrives `t > TTL` after termination THEN the notice is dropped
— regardless of whether the sweep has run." The sweep is an independent
memory-hygiene concern with its own scenarios.

**Why:** `recentlyTerminalRuns` is **not consulted by the gate** in
this change (Decision 1). So the TTL is a memory-hygiene knob only.
Consumers (change 2) check freshness at lookup time. Conflating sweep
cadence with delivery semantics confused round 1 reviewers.

### Decision 8: Drop pending notices on reload (no flush via stale `pi`)

**Choice:** When `previousRuntimeCleanup` runs, the cleanup walks `globalStore.__piSubagentPendingNotices` and **deletes** all entries without calling `pi.sendMessage`. Increment `droppedStaleNotices` by the number dropped.

**Why drop, not flush:** The old `pi` reference held by the previous registration's closure is mid-teardown when reload runs; calling `pi.sendMessage` from a stale pi is undefined behavior. Dropping is the safest invariant.

**Tradeoff (corrected):** A pending notice for a stalled step is lost permanently UNLESS the step recovers and re-stalls. The runner-side activity state is preserved across receiver reload (the runner doesn't reload), so `shouldEmitControlEvent` doesn't re-fire until a state transition. For genuinely-stuck zombie runs this means: reload during stall → no further notification until termination or manual `subagent({action:"status"})` inspection. Acceptable because reload is rare. Documented in CHANGELOG.

### Decision 9: Async-tracker poll order — read status before replay events

**Choice:** Reorder `async-job-tracker.ts:115–140` so `readStatus(job.asyncDir)` and `job.status` update happen BEFORE `emitNewControlEvents(job)`. Today the order is reversed.

**Why:** Round-3 review noted that the bus-emit gate at lines 84/87 reads `state.asyncJobs[runId].status` to call `classifyRunForNotice`, but `emitNewControlEvents` runs first — so the gate sees the previous tick's status. Reordering closes this race. Layer C (delivery-time gate) catches the user-visible case anyway; this is correctness for the bus-emit gate's spec scenario.

## Risks / Trade-offs

- **[Risk] False-drop a notice for a run that a user expects to be
  resumable but the gate classifies as stale** → Mitigation: the gate
  classifies on the actual code's lifecycle, not user expectation.
  `paused` is stale because (a) async-tracker schedules cleanup for it,
  and (b) no `resume` API exists. If paused-resumable lifecycle lands
  as a separate change, this classifier is the obvious follow-up.

- **[Risk] Foreground `terminalState` capture misses an exotic exit
  path (e.g., process crash before `finally` runs)** → Mitigation:
  Node guarantees `finally` runs on normal/throw paths. For SIGKILL of
  the parent process, the entire extension is gone and there's no
  notice to deliver. Acceptable.

- **[Risk] Sweep timer leaks on rapid reloads** → Mitigation: the
  globalStore key is checked and cleared on every registration. Test:
  call `registerSubagentExtension` twice back-to-back; assert exactly
  one sweep timer is active.

- **[Risk] (obsolete — `paused` now classifies as stale, so this risk
  no longer applies)**

- **[Trade-off] Gate is purely suppressive in this change; user-
  visible "this run just ended, here's what happened" comes only with
  `add-foreground-run-status-lookup`** → Documented; sequencing is
  explicit.

- **[Trade-off] `droppedStaleNotices` counts only gate drops, not
  dedupe drops; we add `dedupedNotices` separately** → Operators get
  two distinct rate signals, which is actually clearer.

## Migration Plan

1. Land this change. The user-visible effect: stale notices stop
   appearing in the parent transcript after parallel runs.
2. Land `add-foreground-run-status-lookup` immediately after, so
   parents that *do* call status post-gate get useful answers.
3. Manual verification: re-run the original false-alarm shape (6-way
   parallel reviewers, deterministic >threshold-second stalls); zero
   `subagent_control_notice` messages should appear after "6/6
   succeeded."
4. Watch one release cycle. If a real notice was suppressed, the
   classifier is wrong; revisit.
5. No rollback complexity: revert is one PR.

## Open Questions

- Should `doctor` ever clear the `recentlyTerminalRuns` map manually
  (operator command)? Tabled — sweep is sufficient.
- Should we record `terminalState` for a paused-then-cleaned-up async
  job (i.e., user kills a paused run via `interrupt`)? Probably yes
  with `terminalState: "interrupted"`; surface in the next round.
