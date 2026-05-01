## Why

Even with `fix-control-notice-liveness-gate` and `add-foreground-run-
status-lookup` in place, the watchdog still produces unnecessary parent
turns in two common cases:

1. **Threshold too tight.** Default `needsAttentionAfterMs` is 60s.
 Modern reasoning models routinely think 60–180s between tool calls
 on review-class tasks. The 60s default treats normal cognition as
 stuck.
2. **No coalescing.** When N children of a parallel batch stall in the
 same window, the parent receives N separate `pi.sendMessage` calls,
 each consuming a turn. A 6-way parallel review run with
 simultaneous stalls = six near-identical notices for the same
 `runId`.

This change raises the default threshold, adds short-window
coalescing per `runId`, and updates docs. To do that without parsing
display strings, it also extends `ControlEvent` with structured
`lastActivityAt` and `elapsedMs` fields and updates the renderer so
multi-step notices render as run-level alerts rather than first-event
alerts.

## What Changes

- **Threshold default**: bump
 `DEFAULT_CONTROL_CONFIG.needsAttentionAfterMs` from `60_000` to
 `180_000`. **BREAKING-IN-DEFAULT** for users relying on 60s; minor
 version bump; CHANGELOG documents the override.
- **`ControlConfig.coalesceWindowMs`** (default `1000` ms; `0`
 disables): per-call and per-globalConfig override surface.
 Validation: positive integer or `0`; non-integer / negative falls
 back to default.
- **Sequence**: this change lands AFTER `add-foreground-run-status-
 lookup` so the `Status:` command in coalesced notices answers
 usefully.
- **Extend `ControlEvent`** in `types.ts:61-71` with
 `lastActivityAt?: number` and `elapsedMs?: number`. Populate in
 `buildControlEvent` from inputs already available there. Additive,
 non-breaking; emitters and `events.jsonl` consumers tolerate
 missing fields.
- **Receiver-side coalescing** in `index.ts`. Buffers stored in
 `globalStore.__piSubagentControlNoticeBuffers` (reload-drop on cleanup).
 Buffer shape per `runId`:
 ```
 {
 events: Array<{ event: ControlEvent; noticeText?: string;
 source?: "foreground" | "async"; asyncDir?: string; }>;
 flushTimer: NodeJS.Timeout;
 openedAt: number;
 needsAttentionAfterMs: number; // captured at first event for the multi-step format header
 childIntercomTargets: Map<number, string>;
 dedupKeys: Set<string>;
 }
 ```
 Cap 100 events; overflow increments
 `globalStore.__piSubagentDroppedCoalesceOverflow`. Per-step intercom
 targets and per-event payload metadata are preserved so the formatter
 can render per-step `Nudge:` lines and the N=1 path can prefer the
 pre-built `noticeText`.
- **Within-buffer dedup** by `(runId, index, type)` to prevent
 cross-source duplicates (live bus + async-tracker disk replay).
- **`coalesceWindowMs: 0` still goes through `flush(runId)`** — it
 doesn't bypass the liveness gate. The 0-window path calls the same
 buffer-add + immediate `flush(runId)` rather than a separate publish
 path; this preserves the change-1 liveness re-check at flush time. A
 time-windowed `Map<string, number>` `globalStore.__piSubagentSyncFlushDedup`
 (key → lastSeenAt) provides cross-source dedup with `SYNC_DEDUP_WINDOW_MS
 = 1000`; entries evicted past 30s by a sweep timer.
- **Defer `visibleControlNotices` dedup** to flush time. Replace the
 receive-time `visibleControlNotices.has(controlNotificationKey(event))`
 check with a flush-time check keyed `${runId}:epoch-${epoch}` where
 `epoch` is a per-runId counter stored in
 `globalStore.__piSubagentRunFlushEpoch: Map<string, number>`. The
 epoch advances on every successful publish, so a re-stall after
 recovery on the same step gets a new key and publishes. The epoch
 entry is removed when the run goes terminal
 (consumed via change-1's `recordTerminalRun` hook) so the map is
 bounded.
- **Multi-step format**: when `events.length > 1` at flush, ignore
 every `details.noticeText` and render fresh from
 `formatCoalescedControlNoticeMessage(events, childIntercomTargets, buffer.needsAttentionAfterMs)`
 (note: a Map of per-step targets, NOT a single target). For
 `events.length === 1`, preserve the existing single-step format
 byte-for-byte (post-tuning version, after the hint replacement).
- **Hint replacement**: when `childIntercomTarget` is undefined,
 replace `Nudge: no child message route registered` with `Action:
 this run has no intercom; if it's stuck, use Interrupt above.`.
- **Renderer update**: extend `SubagentControlMessageDetails` with
 `events?: ControlEvent[]`. Update `SubagentControlNoticeComponent`
 header for `events.length > 1` to read "Subagent needs attention:
 run <runId> (<N> steps)" rather than the single-event
 agent-specific header.
- **Reload-DROP coalesce buffers**: on `previousRuntimeCleanup`,
 `clearTimeout` every `flushTimer` and DELETE all buffer entries
 WITHOUT calling `pi.sendMessage`. Increment `droppedStaleNotices` by
 the count dropped. The stale `pi` from the previous registration is
 undefined behavior to call into; the new `pi` may not yet have its
 renderer registered. The next watchdog tick will re-fire notices for
 still-stalled runs. `globalStore.__piSubagentLastPi` is set ONCE at
 registration AFTER `previousRuntimeCleanup()` runs, so the prior
 registration's drop never sees the new `pi`.
- **session_shutdown cleanup**: extend the existing session_shutdown
 handler to clear all `__piSubagent*` buffer/timer/lastPi state so
 pending flush timers cannot fire post-shutdown.
- **Documentation**: README adds a "Tuning the watchdog" section
 covering `needsAttentionAfterMs`, `coalesceWindowMs`, `notifyOn`,
 `notifyChannels` with examples and the migration snippet for the
 60s default. `skills/pi-subagents/SKILL.md` gains "Reading control
 notices" guidance: prefer `Interrupt` for parallel-tasks runs
 without intercom; wait one debounce window before status-checking.

## Capabilities

### New Capabilities

- `subagent-control-tuning`: Defines the coalescing semantics, the
 threshold/coalesce-window configuration surface, the hint
 replacement, and the renderer update for multi-step notices. New
 capability so it doesn't conflict with `subagent-control-notice`
 (owned by the liveness-gate change).

### Modified Capabilities

(none.)

## Impact

- **Code**:
 - `subagent-control.ts` — default threshold, `coalesceWindowMs`
 default, multi-step formatter, hint replacement, `buildControlEvent`
 populates new fields.
 - `index.ts` — coalesce buffer logic, drop-on-reload, renderer
 `events[]` extension, dedupe key shift to flush-level.
 - `types.ts` — `ControlConfig.coalesceWindowMs?: number`,
 `ControlEvent.lastActivityAt?: number`,
 `ControlEvent.elapsedMs?: number`.
 - `schemas.ts` — JSON-schema entry for `coalesceWindowMs` (positive
 integer or `0`).
 - `async-job-tracker.ts` — verify `events.jsonl` reading tolerates
 missing `lastActivityAt`/`elapsedMs` for events written by older
 versions.
 - `README.md` — new "Tuning the watchdog" section.
 - `skills/pi-subagents/SKILL.md` — new "Reading control notices"
 subsection.
 - `CHANGELOG.md` — document the default threshold change as
 BREAKING-IN-DEFAULT under a minor version bump; new
 `coalesceWindowMs` config; structured `ControlEvent` fields.
- **Tests**: unit tests for default threshold, coalesce window
 parsing (default, override, global, 0, negative, NaN); multi-step
 format snapshots (N=1, N=3); hint replacement snapshot. Integration
 tests for coalescing window edge cases, cross-source dedup,
 reload-drop, buffer cap eviction.
- **Public API**:
 - `ControlConfig` gains `coalesceWindowMs` (optional, additive).
 - `ControlEvent` gains `lastActivityAt`, `elapsedMs` (optional,
 additive).
 - `SubagentControlMessageDetails.events?: ControlEvent[]` (internal
 renderer payload in `index.ts`; NOT the public `Details` type)
 for multi-step notices.
 - Default threshold change — BREAKING-IN-DEFAULT only; explicit
 overrides preserve prior behavior.
- **Risk**: medium for the threshold bump (telemetry-light decision).
 Low for coalescing (additive surface, reload-safe).
- **Sequencing**: depends on both `fix-control-notice-liveness-gate`
 and `add-foreground-run-status-lookup`. The latter ensures the
 `Status:` command in coalesced notices works.
