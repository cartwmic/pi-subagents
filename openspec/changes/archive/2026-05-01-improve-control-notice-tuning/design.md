## Context

Two operational issues remain after the liveness gate and status-lookup
land:

1. **60s threshold trips on normal long thinking.** Reviewer-class
   subagents and reasoning models commonly think 60–180s between tool
   calls.
2. **N parallel siblings each fire their own notice.** Each
   `subagent({tasks:[...]})` child has its own activity timer; each
   stalled child emits its own `SUBAGENT_CONTROL_EVENT`; the parent
   gets N parent-turn-triggering notices.

The naive receiver-side coalescing in this change's earlier round
attempted to format multi-step notices in `index.ts` from the existing
`ControlEvent` shape, but `ControlEvent` only carries a pre-formatted
`message: string` plus `ts`, `runId`, `agent`, `index`. The per-step
elapsed seconds visible in the `message` are not present as structured
fields. Reviewers correctly flagged this — and the pre-built
`details.noticeText` would override any multi-step formatter.

This revision (a) extends `ControlEvent` additively so receiver-side
coalescing has the data it needs, (b) makes the buffers reload-safe in
`globalStore`, (c) makes the renderer aware of multi-event notices,
and (d) defers the `visibleControlNotices` dedup to flush time.

## Goals / Non-Goals

**Goals:**

- Default threshold reflects modern model cadence (180s).
- Per-`runId` coalescing combines simultaneous sibling stalls into one
  parent-visible notice.
- Multi-step notices render as run-level alerts, not first-event-
  shaped alerts.
- Tuning is documented and discoverable.
- Coalesce buffers survive `ctx.reload()` patterns; pending buffers
  are dropped on reload (next watchdog tick re-fires; avoids stale-pi
  semantics).
- Single-task runs get the same notice format as the post-hint-
  replacement single-step version (no surprise change for N=1).

**Non-Goals:**

- Per-agent threshold defaults.
- Adaptive thresholds.
- Cross-run coalescing.
- Changing intercom-routing semantics for child nudges.

## Decisions

### Decision 0: Subsume change-1's pending-notices buffer into the per-runId coalesce buffer

**Choice:** This change SUPERSEDES change-1's separate `__piSubagentPendingNotices` buffer. The single buffer is `__piSubagentControlNoticeBuffers` (per-runId); on flush, the buffer's events go through the liveness re-check that change-1 specified for `flushPendingNotices`, then publish (single-step or multi-step format).

**Tasks reconciliation:**
- Change 1 introduces `__piSubagentPendingNotices` and a `flushPendingNotices` function with a tool_result hook + 5s fallback timer.
- This change REUSES the same hook and fallback wiring but operates on `__piSubagentControlNoticeBuffers` (per-runId, with multi-event collection). The rename from "pending" to "coalesce" buffer is essentially a generalization.
- Change 1's `__piSubagentPendingNotices` map and `flushPendingNotices` function are NOT separately implemented if change 3 lands; change 1 ships the data plumbing and change 3 expands it. If change 3 is reverted independently, change 1's simpler shape (single-entry-per-runId pending) is what remains.

**Why subsume:** Round-3 review correctly identified that two parallel buffers (change-1's pending + change-3's coalesce) would either layer (compounding latency) or fight (double-publish). Subsumption gives one canonical receive-buffer with one canonical flush.

### Decision 1: Threshold bumps to 180s

**Choice:** `DEFAULT_CONTROL_CONFIG.needsAttentionAfterMs = 180_000`.

**Why:** Reviewer-class subagents in the recorded false-alarm session
exhibited 60–120s pauses between tool calls. 180s gives a 50%+ margin.
The "180s as midpoint" call is admittedly anecdotal — telemetry across
more sessions would refine it; left as a follow-up.

**Migration:** Users who depended on 60s set `control:
{ needsAttentionAfterMs: 60_000 }` per-call or in their global config.

**Alternative considered:** 300s. Rejected — too lax for genuine
zombies. 60s — rejected per round 1.

### Decision 2: Coalescing is a per-`runId` debounced buffer (default 1000ms); single `flush(runId)` signature

**Choice:** In `index.ts:controlEventHandler`, accumulate events keyed by `runId` into a buffer. Schedule `setTimeout(() => flush(runId), coalesceWindowMs).unref()` on first event for a runId. Subsequent events for the same `runId` accumulate without re-scheduling. On flush, emit one `subagent_control_notice` covering all events; clear the buffer.

The `flush(runId)` function takes a single argument (`runId`) and reads `pi` from `globalStore.__piSubagentLastPi` internally. This is the only signature; tasks 5.1, 5.2, and the cleanup path all use the same form. `globalStore.__piSubagentLastPi` is set ONCE at extension registration AFTER `previousRuntimeCleanup` runs (so the previous registration's reload-drop never sees the new `pi`).

**Why 1000ms not 500ms:** `execution.ts:setInterval(..., 1000)` and
`subagent-runner.ts:setInterval(..., 1000)` are independent timers
started at different start times — they are NOT synchronized to a
shared 1s tick (round-1 reviewer correctly disputed an earlier claim
that they were). Sibling stalls can land 0–999ms apart depending on
relative start phase. 1000ms is the smallest window that absorbs full
jitter; 500ms would miss ~half of sibling pairs.

**Why per-`runId`:** Different runs are independent alerts; coalescing
across runs would muddle them. Same run + same window = one alert.

### Decision 3: Within-buffer dedup by `(runId, index, type)`

**Choice:** Each buffer maintains a `Set<string>` keyed by
`${event.runId}:${event.index ?? 'none'}:${event.type}`. Events with
duplicate keys (e.g., live-bus event + async-tracker disk replay) are
dropped from the buffer.

**Why:** Without this, the live bus and the async-tracker can both
emit a `needs_attention` for the same `(runId, index)` within the
window, and the multi-step format would say "2 steps stalled" when
only one logical step is. Round-1 reviewer caught this.

### Decision 4: Defer `visibleControlNotices` dedup to flush time with per-runId flush epoch

**Choice:** Replace the existing `if (visibleControlNotices.has(key)) return;` check in `controlEventHandler` (receive-time) with a flush-time check keyed `${runId}:epoch-${epoch}` where `epoch` is a per-runId counter incremented after each successful publish (stored in `globalStore.__piSubagentRunFlushEpoch: Map<string, number>`).

**Why per-runId epoch (not content-addressed key):** Round-3 review identified that a content-addressed key like `${runId}:keys-${sortedDedupKeys}` would suppress legitimate re-stalls forever — a stall → recover → re-stall sequence on the same step would hit the identical key. The epoch counter advances on every successful publish, so a re-stall for the same step in a later epoch produces a new key and publishes.

**Use:** At flush, compute `flushKey = ${runId}:epoch-${currentEpoch}` (read epoch via `globalStore.__piSubagentRunFlushEpoch.get(runId) ?? 0`). If `visibleControlNotices.has(flushKey)`, return (rare double-flush guard). Otherwise publish, then increment the epoch (`set(runId, currentEpoch + 1)`) and add `flushKey` to `visibleControlNotices`.

**Re-stall test:** Two notices for the same step separated by recovery produce two flushes with different epochs and publish twice.

### Decision 5: Extend `ControlEvent` with `lastActivityAt` and `elapsedMs`

**Choice:** Add two optional fields to `ControlEvent` in
`types.ts:61-71`:

```ts
lastActivityAt?: number;  // ms epoch, copied from progress
elapsedMs?: number;       // ts - lastActivityAt at build time
```

Populate both in `buildControlEvent` (`subagent-control.ts:78-100`)
from inputs already passed in. Both fields are optional so older
events on disk (from `events.jsonl`) tolerate absence.

**Why:** The multi-step formatter needs structured per-step elapsed
data. Without this extension, it would have to regex-extract from
`event.message` (brittle) or recompute from `Date.now() - event.ts`
(semantically wrong — that's "elapsed since the event fired", not
"elapsed since last activity"). Round-1 reviewer correctly flagged
this.

**Backward compat:** `events.jsonl` consumers (`async-job-tracker.ts:
emitNewControlEvents`) parse JSON; missing fields are simply
`undefined`. Tests cover both old-format and new-format event lines.

### Decision 6: Multi-step format ignores pre-built `noticeText`

**Choice:** At flush, when `events.length > 1`, the formatter renders
fresh from `formatCoalescedControlNoticeMessage(events, childIntercomTargets, buffer.needsAttentionAfterMs)`. Earlier drafts wrote `formatCoalescedControlNoticeMessage(events,
childIntercomTarget)` and discards every `payload.noticeText`. When
`events.length === 1`, the formatter prefers the pre-built
`noticeText` (preserves byte-identical output across emitters) and
applies the post-hint-replacement single-step format if absent.

**Why:** Emitters in `subagent-executor.ts:216`,
`subagent-runner.ts:901`, and `async-job-tracker.ts:81` all build
single-step `noticeText` at emit time. The receiver must override
this for N>1 to produce the multi-step text. Round-1 P0 caught the
fall-through that would otherwise emit a single-step notice for an
N=3 flush.

### Decision 7: Renderer accepts `events: ControlEvent[]` for multi-step

**Choice:** Extend `SubagentControlMessageDetails` (in `index.ts`)
with `events?: ControlEvent[]`. The render component
`SubagentControlNoticeComponent` checks `events.length > 1`:
- If yes, header reads `Subagent needs attention: run <runId> (<N>
  steps)`.
- If no (single-step), header is unchanged: `Subagent needs
  attention: <agent>`.

**Why:** The current header (`details.event.agent`) is wrong for a
multi-agent parallel batch. Round-1 reviewer flagged this.

### Decision 7b: Bus payload extended with resolved `controlConfig` scalars

**Choice:** Extend the bus payload (built in `subagent-executor.ts:emitControlNotification` and `async-job-tracker.ts:emitNewControlEvents`) with `needsAttentionAfterMs` and `coalesceWindowMs` from the resolved `ControlConfig`. The receiver captures these per-buffer at the first event so the multi-step formatter can render the correct threshold (per-call overrides) and the flush timer can schedule at the correct delay.

**Why:** Final-validation review identified that the receiver is a global singleton with no visibility into per-call overrides; without payload extension, scenarios like "buffer captures threshold for multi-step format with 5_000ms override" are physically unreachable. Two-line additions to the two emit sites preserve the documented per-call contract.

**Backward compat:** Older `events.jsonl` records without these fields fall back to `loadConfig()` global defaults via `payload.needsAttentionAfterMs ?? loadConfig().needsAttentionAfterMs`.

### Decision 7c: Emitter-side dedup clears on recovery transition

**Choice:** When `shouldEmitControlEvent` observes a transition `needs_attention → undefined`, the emitter SHALL `delete` the corresponding key from `emittedControlEventKeys`. Sites: `execution.ts:275-303`, `subagent-runner.ts:892-940`.

**Why:** Final-validation review identified that the receiver's per-runId flush epoch (Decision 4) is dead code without this. The emitter dedup blocks the second emission of the same key after stall → recover → re-stall, so the receiver never sees the re-stall and the epoch counter never advances. Clearing on recovery is the correct semantic: the dedup protects against duplicate emissions for the SAME state, not against legitimate re-stalls in a new state.

### Decision 8: Drop coalesce buffers on reload (no flush via stale `pi`)

**Choice:** Buffers live in `globalStore.__piSubagentControlNoticeBuffers`. On `previousRuntimeCleanup`, the cleanup `clearTimeout`'s every `flushTimer` and DELETES all buffer entries WITHOUT calling `pi.sendMessage`. Increment `droppedStaleNotices` by the count dropped.

**Why drop, not flush:** Round-3 review identified that the old `pi` reference in the previous registration's closure is mid-teardown when reload runs. Calling `pi.sendMessage` from a stale pi is undefined behavior; calling it from the NEW pi before the new instance has registered the `SUBAGENT_CONTROL_MESSAGE_TYPE` renderer fails to render the multi-step header. Both paths are lossy. Dropping is the safest invariant; the next watchdog tick will re-fire notices for still-stalled runs.

**Tradeoff (corrected):** A pending coalesced notice for a stalled step is lost permanently UNLESS the step recovers and re-stalls. The runner-side activity state is preserved across receiver reload (the runner doesn't reload), so `shouldEmitControlEvent` doesn't re-fire until a state transition. For a genuinely-stuck zombie run, this means reload during stall → no further notification until the run terminates or the user manually inspects via `subagent({action:"status"})`. Acceptable because reload is rare; CHANGELOG documents the loss.

### Decision 9: Hint replacement only when intercom is absent

**Choice:** In `formatControlNoticeMessage` (and the multi-step
formatter), when `childIntercomTarget === undefined`, the line
`Nudge: no child message route registered` is replaced with `Action:
this run has no intercom; if it's stuck, use Interrupt above.`. When
`childIntercomTarget` is defined, the existing `Nudge: intercom({
... })` line is preserved.

**Why:** The old text is internal-implementation-speak. The
replacement names the actionable command (`Interrupt`).

## Risks / Trade-offs

- **[Risk] 180s default delays detection of genuine zombies by 2
  minutes** → Mitigation: documented as default; tunable via
  `needsAttentionAfterMs`. For dev/debug, override to a smaller
  value.

- **[Risk] 1000ms window swallows quick stall→recover→stall cycles**
  → Mitigation: per Decision 2, `shouldEmitControlEvent` only fires on
  transitions; a recover→stall cycle is naturally one stall in this
  window.

- **[Risk] Cross-source dedup misses an event from an unforeseen
  third source** → Mitigation: dedup key `(runId, index, type)` is
  source-agnostic. Any future source that emits the same key gets
  deduped automatically.

- **[Risk] Reload-flush emits notices for runs that have completed
  during the reload** → Mitigation: drop-on-reload (Decision 8) avoids
  this entirely. Earlier drafts considered flush-on-reload calling into the
  same liveness gate from `fix-control-notice-liveness-gate`.
  Already-terminal runs would be dropped by that gate at flush time.

- **[Trade-off] Single-task callers see the same notice format
  (post-hint-replacement)** → The "Action:" line is new for them too,
  but it's a strict improvement over the old "Nudge: no child message
  route registered" text.

- **[Risk] `events.jsonl` written by older versions lacks
  `lastActivityAt`/`elapsedMs`** → Mitigation: fields are optional;
  the multi-step formatter falls back to recomputing from `event.ts`
  if `lastActivityAt` is absent (last-resort behavior, documented).

## Migration Plan

1. Land after `add-foreground-run-status-lookup` so the `Status:`
   command in coalesced notices is actionable.
2. Minor version bump for the threshold default change.
3. CHANGELOG entry documents:
   - New default 180s threshold (BREAKING-IN-DEFAULT).
   - One-line snippet to restore 60s.
   - New `coalesceWindowMs` config (default 1000ms).
   - `ControlEvent` gains optional `lastActivityAt`, `elapsedMs`.
   - Hint text update.
4. Update bundled skill text.
5. Manual verification: parallel-batch repro with deterministic
   stalls produces ONE coalesced notice for the parent, not N
   separate ones.

## Open Questions

(All round-1 open questions resolved in this revision: `coalesceWindowMs:
0` disables coalescing — moved into Decision 2; reload behavior is
flush-immediately — Decision 8; default is 1000ms not 500ms —
Decision 2; intercom dedup is per-flush — Decision 4.)

- Should `doctor.ts` surface the coalesce-overflow counter? Yes, in
  the same "Control notices" section change-1 introduces. Tracked in
  tasks.
