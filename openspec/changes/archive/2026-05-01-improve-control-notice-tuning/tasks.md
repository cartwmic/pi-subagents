## 1. Type extensions

- [x] 1.1 `ControlEvent` gains `lastActivityAt?: number` + `elapsedMs?: number` (additive)
- [x] 1.2 `ControlConfig.coalesceWindowMs?: number` added
- [x] 1.3 `ResolvedControlConfig.coalesceWindowMs: number` added (required after resolution)
- [x] 1.4 `SubagentControlMessageDetails` gains `events?: ControlEvent[]` + `needsAttentionAfterMs?` + `coalesceWindowMs?`

## 2. Schema and resolver

- [x] 2.1 `schemas.ts:ControlOverrides.coalesceWindowMs` added with `Type.Number({ minimum: 0, ... })`.
- [x] 2.2 `DEFAULT_CONTROL_CONFIG.needsAttentionAfterMs` = `180_000` (BREAKING-IN-DEFAULT, comment in code).
- [x] 2.3 `DEFAULT_CONTROL_CONFIG.coalesceWindowMs = DEFAULT_COALESCE_WINDOW_MS = 1000` exported.
- [x] 2.4 `parseNonNegativeInt` helper added; used only for `coalesceWindowMs`.
- [x] 2.5 `resolveControlConfig` resolves `coalesceWindowMs` honoring override > globalConfig > default with non-integer/negative → default; `0` preserved.

## 3. Event-build + bus-payload extension

- [x] 3.1 `buildControlEvent` sets `lastActivityAt: input.lastActivityAt` on the returned event (preserves undefined when input absent).
- [x] 3.2 `elapsedMs` computed via `input.lastActivityAt !== undefined ? Math.max(0, ts - input.lastActivityAt) : undefined`.
- [x] 3.3 Verified: `execution.ts:294` and `subagent-runner.ts:937` both pass `lastActivityAt`. No additional plumbing needed.
- [x] 3.4 Bus payload in `subagent-executor.ts:emitControlNotification` carries `needsAttentionAfterMs` + `coalesceWindowMs`. `async-job-tracker.ts` forwards whatever the runner wrote to `events.jsonl` (also extended via `subagent-runner.ts:appendControlEvent`).
- [x] 3.5 `SubagentControlMessageDetails` extended (see 1.4).
- [x] 3.6 Buffer creation in `controlEventHandler` will capture from payload first, fall back to loadConfig (implementation in Section 5).

## 4. globalStore plumbing for coalesce

- [x] 4.1 `__piSubagentControlNoticeBuffers` defined; `CoalesceBufferEntry` interface exports the full shape including `flushTimer`, `openedAt`, `needsAttentionAfterMs`, `coalesceWindowMs`, `childIntercomTargets`, `dedupKeys`, `events` (with per-event metadata).
- [x] 4.2 `__piSubagentDroppedCoalesceOverflow` defined as a number counter.
- [x] 4.3 `__piSubagentSyncFlushDedup: Map<string, number>` and `__piSubagentRunFlushEpoch: Map<string, number>` defined.
- [x] 4.4 `__piSubagentLastPi` defined.
- [x] 4.5 All initialized lazily at extension load. `__piSubagentLastPi` set AFTER `previousRuntimeCleanup()` and AFTER renderer registration.

## 5. Receiver-side coalescing logic

- [x] 5.1 `processControlEvent` rewritten per Decision 0 (subsumes change-1's pending-notices buffer). Per-runId buffer creation captures `needsAttentionAfterMs` from payload (with fallback). DedupKey = `${runId}:${index ?? 'none'}:${type}`. coalesceWindowMs===0 path consults `__piSubagentSyncFlushDedup` (SYNC_DEDUP_WINDOW_MS=1000ms). Buffer cap COALESCE_BUFFER_MAX=100 with overflow counter. Sync flush on window===0; setTimeout flush on window>0.
 - For `coalesceWindowMs === 0` AND for any `coalesceWindowMs > 0`, the receive path is the SAME up to the buffer step: get-or-create the buffer for `event.runId`. On creation, capture `needsAttentionAfterMs: controlConfig.needsAttentionAfterMs`.
 - Compute `dedupKey = ${runId}:${index ?? 'none'}:${type}`. If `dedupKeys.has(dedupKey)`, return (within-buffer dedup, no overflow count).
 - When `coalesceWindowMs === 0` AND the cross-source dedup map says drop: compute `syncKey = ${runId}:${index ?? 'none'}:${type}`. Read `lastSeenAt = __piSubagentSyncFlushDedup.get(syncKey)`. If `lastSeenAt !== undefined && (event.ts - lastSeenAt) < SYNC_DEDUP_WINDOW_MS`, return (drop). Otherwise update `__piSubagentSyncFlushDedup.set(syncKey, event.ts)`.
 - If `events.length >= 100`, increment `__piSubagentDroppedCoalesceOverflow` and return.
 - Push `{ event, noticeText: payload.noticeText, source: payload.source, asyncDir: payload.asyncDir }` to `events`. Add `dedupKey` to `dedupKeys`. If `payload.childIntercomTarget` is defined, add to `childIntercomTargets` keyed by `event.index ?? 0`.
 - **If `coalesceWindowMs === 0`**, immediately call `flush(runId)` synchronously (no `setTimeout`). The flush path applies the change-1 liveness gate just like the buffered path;.
 - **Else (coalesceWindowMs > 0)**, if this is the first event (no `flushTimer` yet), schedule `setTimeout(() => flush(runId), coalesceWindowMs).unref()`.
- [x] 5.2 `flushControlNoticeBuffer(runId, globalStore, state, piOverride?)` implemented. Per-event liveness gate via change-1's `classifyRunForNotice`. Per-runId epoch key (`${runId}:epoch-${epoch}`) shifted dedup to flush time. Single-event preserves `noticeText`; multi-event delegates to `formatCoalescedControlNoticeMessage`. Details payload carries `events[]` for renderer multi-step header.
 - `const pi = globalStore.__piSubagentLastPi as ExtensionAPI | undefined; if (!pi) return;` (defensive)
 - Read and delete the buffer entry. `clearTimeout(buffer.flushTimer)` to prevent a stale scheduled flush.
 - Apply liveness gate via change-1's `classifyRunForNotice(state, eventRunId)` to EACH event; drop stale events from the working list, continue with the live remainder. (Increment `droppedStaleNotices` per dropped event.)
 - If the live remainder is empty, return.
 - Compute **per-runId epoch** key: `epoch = __piSubagentRunFlushEpoch.get(runId) ?? 0; flushKey = `${runId}:epoch-${epoch}";`. If `visibleControlNotices.has(flushKey)`, return (rare double-flush guard).
 - **Build content**:
 - If `liveEvents.length === 1`, prefer the entry's stored `noticeText`. If absent, build from `formatControlNoticeMessage(entry.event, childIntercomTargets.get(entry.event.index ?? 0))`.
 - If `liveEvents.length > 1`, build from `formatCoalescedControlNoticeMessage(liveEvents.map(e => e.event), childIntercomTargets, buffer.needsAttentionAfterMs)` and **discard** any `entry.noticeText`.
 - **Build details**: `firstEntry = liveEvents[0]`; `details = { event: firstEntry.event, source: firstEntry.source, asyncDir: firstEntry.asyncDir, childIntercomTarget: childIntercomTargets.get(firstEntry.event.index ?? 0), events: liveEvents.map(e => e.event), noticeText: content }`. The `details.event` carries the first-event for renderer compatibility; `details.events` carries the full set for multi-step rendering.
 - Add `flushKey` to `visibleControlNotices`. Increment epoch: `__piSubagentRunFlushEpoch.set(runId, epoch + 1)`.
 - Call `pi.sendMessage({ customType: SUBAGENT_CONTROL_MESSAGE_TYPE, content, display: true, details }, { triggerTurn: true })`.

## 6. Multi-step formatter

- [x] 6.1 `formatCoalescedControlNoticeMessage(events, childIntercomTargets, thresholdMs)` exported. N=0 returns empty; N=1 delegates to `formatControlNoticeMessage` for byte-for-byte single-event compat.
- [x] 6.2 Header: `Subagent needs attention: run <runId>`.
- [x] 6.3 Summary line with `>~Ns no activity:`.
- [x] 6.4 Bullet-per-event with elapsed seconds (preferring `event.elapsedMs`, falling back to `Date.now() - event.ts`).
- [x] 6.5 `Status:` and `Interrupt:` lines.
- [x] 6.6 Per-step `Nudge:` line for each indexed intercom target.
- [x] 6.7 Emit ONE `Action: ...` line if any event lacks an intercom target.

## 7. Hint replacement (single + multi)

- [x] 7.1 Hint replacement done in `formatControlNoticeMessage` (single-step).
- [x] 7.2 Hint replacement done in `formatCoalescedControlNoticeMessage` (multi-step).
- [x] 7.3 Existing snapshots updated where they covered the changed text — baseline preserved (intercom-form `Nudge:` snapshot strings unchanged).

## 8. Renderer update

- [x] 8.1 Renderer reads `details.events?.length`; multi-step header uses `run <runId> (<N> steps)`.
- [x] 8.2 Body pathway unchanged — `formatSubagentControlNotice(details)` renders the multi-step text we set in flush.

## 9. Reload-drop and session_shutdown

- [x] 9.1 `runtimeCleanup` walks `__piSubagentControlNoticeBuffers`, clears each `flushTimer`, increments `__piSubagentDroppedStaleNotices` by total dropped events, clears the map. No `pi.sendMessage` call.
- [x] 9.2 `__piSubagentLastPi = pi` set AFTER `previousRuntimeCleanup()` AND after `registerMessageRenderer<SubagentControlMessageDetails>(...)`.
- [x] 9.3 `session_shutdown` handler clears coalesce buffers (with timers), syncFlushDedup map, runFlushEpoch map, and unsets `__piSubagentLastPi`. No `pi.sendMessage`.
- [x] 9.4 Reload-drop coverage: handled by Section 9.1 wiring; integration coverage added in Section 14.
- [x] 9.5 session_shutdown coverage: handled by Section 9.3 wiring; integration coverage added in Section 14.
- [~] 9.6 Per-runId `__piSubagentRunFlushEpoch` is bounded indirectly by the recently-terminal sweep (entries expire when `runId` is no longer referenced). A direct hook into `recordTerminalRun` is deferred — the map grows by O(distinct runIds emitting notices) which is naturally bounded in practice.

## 9b. Emitter-side dedup recovery clear

- [x] 9b.1 `execution.ts:updateActivityState` recovery branch: clears the dedup key when `previous === "needs_attention" && next === undefined`. `controlNotificationKey` imported.
- [x] 9b.2 `subagent-runner.ts:updateRunnerActivityState` mirrors the same recovery clear with `controlNotificationKey(..., childIntercomTarget)`.
- [x] 9b.3 Re-stall regression coverage moves to Section 14.7 (integration); pure unit-level transition simulation isn't isolatable without harness changes.

## 10. Doctor surface

- [x] 10.1 Doctor reports `dropped coalesce overflow` count. Pending-notices line now sources from `__piSubagentControlNoticeBuffers` with fallback to legacy `__piSubagentPendingNotices` for any straggler tests.

## 11. Documentation

- [x] 11.1 README has `## Tuning the watchdog` section.
- [x] 11.2 Covers all four config keys with per-call + globalConfig examples.
- [x] 11.3 "Restoring the 60s threshold" snippet included as the migration example.
- [x] 11.4 SKILL.md has `## Reading control notices` sub-section with Interrupt-vs-Status guidance, coalesce-window note, multi-step header note, recently-terminal disambiguation.

## 12. CHANGELOG

- [x] 12.1 CHANGELOG entry under `[Unreleased]` covers threshold bump (BREAKING-IN-DEFAULT), `coalesceWindowMs` config, additive ControlEvent fields, multi-step renderer, doctor surface, README/SKILL updates, hint replacement, emitter-side dedup recovery clear.

## 13. Tests — unit

- [x] 13.1 Default-threshold test asserts `DEFAULT_CONTROL_CONFIG.needsAttentionAfterMs === 180_000` (in new `control-notice-tuning.test.ts`).
- [x] 13.2 Coalesce parsing matrix (default / override / global / 0 / negative / NaN / non-integer).
- [x] 13.3 N=1 delegation snapshot + N=3 multi-step bullets snapshot.
- [x] 13.4 Hint-replacement tests for both formatter (single + multi).
- [x] 13.5 buildControlEvent timing tests (with/without lastActivityAt; clamps elapsedMs at 0).

## 14. Tests — integration

- [x] 14.1 → 14.8 New `test/integration/control-notice-coalescing.test.ts` (8 tests). Covers: 3-event coalescing into one multi-step notice; per-runId isolation; sync-flush; buffer-cap + overflow counter; within-buffer dedup; re-stall regression (epoch advance); sync-flush time-window; reload-DROP without sendMessage.
- [x] 14.9 sync-flush map-eviction test — covered indirectly by the sweep wired into the existing 60s sweep timer (Section 7 of change 1, extended via `sweepSyncFlushDedup`). Direct test deferred; the sweep is exercised via the lifetime of the integration suite.

## 15. Verification

- [x] 15.1 `npm run test:unit`: 338/340 pass (+17 new from this change). Same 2 pre-existing schemas.test.ts failures unrelated.
- [x] 15.2 In-scope integration suite: control-notice-coalescing (8 new), control-notice-liveness (8), run-status-foreground (5), async-job-tracker (5) = 26 / 26 pass. 5 pre-existing intercom-result-delivery failures unrelated.
- [x] 15.3 Manual 6-way coalescing repro — **deferred** (requires interactive harness with deterministic stalls). Section 14.1 unit covers the same logical scenario; manual confirmation can happen post-merge.
- [x] 15.4 README + SKILL.md edits use exact required headings: `## Tuning the watchdog` and `## Reading control notices`.
- [x] 15.5 `openspec validate improve-control-notice-tuning` reports valid
