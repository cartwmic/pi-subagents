## 1. Type extensions

- [ ] 1.1 In `types.ts:61-71` (`ControlEvent`), add optional `lastActivityAt?: number` and `elapsedMs?: number`
- [ ] 1.2 In `types.ts` (`ControlConfig` interface, around line ~50), add optional `coalesceWindowMs?: number`
- [ ] 1.3 In `types.ts` (`ResolvedControlConfig`), add `coalesceWindowMs: number` (required after resolution)
- [ ] 1.4 In `index.ts` `SubagentControlMessageDetails` interface, add optional `events?: ControlEvent[]`

## 2. Schema and resolver

- [ ] 2.1 In `schemas.ts`, add `coalesceWindowMs: Type.Optional(Type.Number({ minimum: 0, description: "Per-runId coalesce window in milliseconds; 0 disables." }))` to the control schema. **Use `Type.Number`, not `Type.Integer`** — the resolver normalizes non-integer values back to default; the schema accepts the wider range and lets the resolver enforce the policy.
- [ ] 2.2 In `subagent-control.ts`, change `DEFAULT_CONTROL_CONFIG.needsAttentionAfterMs` from `60_000` to `180_000`
- [ ] 2.3 Add `coalesceWindowMs: 1000` to `DEFAULT_CONTROL_CONFIG`
- [ ] 2.4 In `parsePositiveInt`, accept `0` as valid for `coalesceWindowMs` only — write a small helper `parseNonNegativeInt` and use it for that field
- [ ] 2.5 In `resolveControlConfig`, parse `coalesceWindowMs` honoring override > globalConfig > default; non-integer/negative falls back to default; `0` is preserved (disables coalescing)

## 3. Event-build + bus-payload extension

- [ ] 3.1 In `subagent-control.ts:78-100` (`buildControlEvent`), set `lastActivityAt: input.lastActivityAt` on the returned event when defined
- [ ] 3.2 Set `elapsedMs: input.lastActivityAt !== undefined ? Math.max(0, ts - input.lastActivityAt) : undefined`
- [ ] 3.3 Verify all callers of `buildControlEvent` (`execution.ts:285`, `subagent-runner.ts:931`) pass `lastActivityAt` (already done in `execution.ts:294`; verify and add for runner if missing)
- [ ] 3.4 **Extend bus payload** at `subagent-executor.ts:emitControlNotification` (line 202): add `needsAttentionAfterMs: input.controlConfig.needsAttentionAfterMs` and `coalesceWindowMs: input.controlConfig.coalesceWindowMs` to the payload object before `pi.events.emit(SUBAGENT_CONTROL_EVENT, payload)` and the intercom emit. Mirror at `async-job-tracker.ts:75-83` (`emitNewControlEvents`): include the resolved `controlConfig` values in the emitted payload.
- [ ] 3.5 Update `SubagentControlMessageDetails` interface in `index.ts` to include `needsAttentionAfterMs?: number` and `coalesceWindowMs?: number` (optional for backward-compat with older `events.jsonl`).
- [ ] 3.6 At buffer creation in `controlEventHandler`, capture `needsAttentionAfterMs = payload.needsAttentionAfterMs ?? loadConfig().needsAttentionAfterMs` and `coalesceWindowMs = payload.coalesceWindowMs ?? loadConfig().coalesceWindowMs` so older payloads still flow.

## 4. globalStore plumbing for coalesce

- [ ] 4.1 In `index.ts`, define a new key `__piSubagentControlNoticeBuffers` storing `Map<string, { events: Array<{ event: ControlEvent; noticeText?: string; source?: "foreground" | "async"; asyncDir?: string }>; flushTimer: NodeJS.Timeout; openedAt: number; needsAttentionAfterMs: number; dedupKeys: Set<string>; childIntercomTargets: Map<number, string> }>`. The per-event payload metadata (noticeText/source/asyncDir) is required for the N=1 prefer-prebuilt rule and downstream renderer signals. `needsAttentionAfterMs` is captured at the first event so the multi-step format header reflects the run's threshold.
- [ ] 4.2 Define `__piSubagentDroppedCoalesceOverflow` as a number counter
- [ ] 4.3 Define `__piSubagentSyncFlushDedup: Map<string, number>` (key → lastSeenAt timestamp) for the `coalesceWindowMs === 0` cross-source dedup path. Define `__piSubagentRunFlushEpoch: Map<string, number>` for per-runId flush epoch counters.
- [ ] 4.4 Define `__piSubagentLastPi` to hold the current `pi` reference (used by post-cleanup flushes that occur DURING the new instance's lifetime; reload-drop never invokes it)
- [ ] 4.5 Initialize all on extension load if absent. At registration, `globalStore.__piSubagentLastPi = pi`.

## 5. Receiver-side coalescing logic

- [ ] 5.1 Replace the body of `controlEventHandler` (`index.ts` ~line 492). Note: this REPLACES change-1's pending-notices buffer entirely (Decision 0 — subsumption):
 - For `coalesceWindowMs === 0` AND for any `coalesceWindowMs > 0`, the receive path is the SAME up to the buffer step: get-or-create the buffer for `event.runId`. On creation, capture `needsAttentionAfterMs: controlConfig.needsAttentionAfterMs`.
 - Compute `dedupKey = ${runId}:${index ?? 'none'}:${type}`. If `dedupKeys.has(dedupKey)`, return (within-buffer dedup, no overflow count).
 - When `coalesceWindowMs === 0` AND the cross-source dedup map says drop: compute `syncKey = ${runId}:${index ?? 'none'}:${type}`. Read `lastSeenAt = __piSubagentSyncFlushDedup.get(syncKey)`. If `lastSeenAt !== undefined && (event.ts - lastSeenAt) < SYNC_DEDUP_WINDOW_MS`, return (drop). Otherwise update `__piSubagentSyncFlushDedup.set(syncKey, event.ts)`.
 - If `events.length >= 100`, increment `__piSubagentDroppedCoalesceOverflow` and return.
 - Push `{ event, noticeText: payload.noticeText, source: payload.source, asyncDir: payload.asyncDir }` to `events`. Add `dedupKey` to `dedupKeys`. If `payload.childIntercomTarget` is defined, add to `childIntercomTargets` keyed by `event.index ?? 0`.
 - **If `coalesceWindowMs === 0`**, immediately call `flush(runId)` synchronously (no `setTimeout`). The flush path applies the change-1 liveness gate just like the buffered path;.
 - **Else (coalesceWindowMs > 0)**, if this is the first event (no `flushTimer` yet), schedule `setTimeout(() => flush(runId), coalesceWindowMs).unref()`.
- [ ] 5.2 Implement `flush(runId)` (single-argument signature). Reads `pi` from `globalStore.__piSubagentLastPi` internally:
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

- [ ] 6.1 In `subagent-control.ts`, export `formatCoalescedControlNoticeMessage(events: ControlEvent[], childIntercomTargets: Map<number, string>, thresholdMs: number): string`. The `thresholdMs` argument is REQUIRED (the buffer captures it at first event); the formatter renders `>~${Math.floor(thresholdMs / 1000)}s no activity:`.
- [ ] 6.2 Header: `Subagent needs attention: run <events[0].runId>`
- [ ] 6.3 Summary: `${events.length} steps stalled (>~${Math.floor((threshold ?? DEFAULT_CONTROL_CONFIG.needsAttentionAfterMs) / 1000)}s no activity):`
- [ ] 6.4 Bullet per event: ` - step ${(event.index ?? 0) + 1} (${event.agent}): no activity for ${elapsedSeconds}s`. `elapsedSeconds = event.elapsedMs !== undefined ? Math.floor(event.elapsedMs / 1000) : Math.floor((Date.now() - event.ts) / 1000)`
- [ ] 6.5 `Status:` and `Interrupt:` lines per existing format
- [ ] 6.6 Per-step `Nudge:` lines: for each event with `childIntercomTargets.get(event.index ?? 0)` defined, emit ` step <index+1>: Nudge: intercom({ action: "send", to: "<target>", message: "What are you blocked on?" })`
- [ ] 6.7 If ANY event lacks an intercom target, emit ONE `Action: this run has no intercom; if it's stuck, use Interrupt above.` line

## 7. Hint replacement (single + multi)

- [ ] 7.1 In `formatControlNoticeMessage` (`subagent-control.ts:122`), when `childIntercomTarget === undefined`, replace `Nudge: no child message route registered` with `Action: this run has no intercom; if it's stuck, use Interrupt above.`
- [ ] 7.2 In `formatCoalescedControlNoticeMessage`, apply the same replacement
- [ ] 7.3 Update existing snapshot tests (`test/integration/async-job-tracker.test.ts:247`, `test/unit/subagent-control.test.ts:95`) — the snapshots that include intercom-form `Nudge:` survive; add new snapshots for the no-intercom form

## 8. Renderer update

- [ ] 8.1 In `index.ts`, `SubagentControlNoticeComponent.render`: read `details.events?.length`. When `> 1`, render header `⚠ Subagent needs attention: run <runId> (<N> steps)` (using `events[0].runId`). Otherwise unchanged.
- [ ] 8.2 The body text uses `formatSubagentControlNotice(details)` which already prefers `details.noticeText` — that pathway naturally renders the multi-step text we set in step 5.2

## 9. Reload-drop and session_shutdown

- [ ] 9.1 In `previousRuntimeCleanup` closure: walk `globalStore.__piSubagentControlNoticeBuffers`, `clearTimeout` every `flushTimer`, DELETE all entries, increment `__piSubagentDroppedStaleNotices` by the count dropped. Do NOT call `pi.sendMessage` from the cleanup.
- [ ] 9.2 At extension registration, AFTER `previousRuntimeCleanup()` has run AND AFTER `pi.registerMessageRenderer<SubagentControlMessageDetails>(...)` is called, set `globalStore.__piSubagentLastPi = pi`.
- [ ] 9.3 Extend the existing `session_shutdown` handler in `index.ts` to: (a) `clearTimeout` every `flushTimer` in `__piSubagentControlNoticeBuffers`; (b) delete all buffer entries; (c) clear `__piSubagentSyncFlushDedup`; (d) clear `__piSubagentRunFlushEpoch`; (e) unset `__piSubagentLastPi`. Do NOT call `pi.sendMessage` during shutdown (no ghost notices).
- [ ] 9.4 Add an integration test asserting reload-drop never invokes `pi.sendMessage`.
- [ ] 9.5 Add an integration test asserting session_shutdown leaves no pending flush timers and no `pi.sendMessage` is invoked post-shutdown.
- [ ] 9.6 Hook into change-1's `recordTerminalRun` (or post-record callback) to clear the per-runId `__piSubagentRunFlushEpoch` entry, bounding the map.

## 9b. Emitter-side dedup recovery clear

- [ ] 9b.1 In `execution.ts:275-303` (where `shouldEmitControlEvent` runs), detect the recovery transition (`previous === "needs_attention" && next === undefined`) and call `emittedControlEventKeys.delete(controlNotificationKey(event, target))` for the appropriate key. Without this, the emitter dedup permanently blocks the second emission of the same key after a stall → recover → re-stall cycle, and the receiver's per-runId flush epoch (Decision 4) becomes dead code for its primary use case.
- [ ] 9b.2 Mirror in `subagent-runner.ts:892-940` (the runner-side dedup structure).
- [ ] 9b.3 Add a unit test in `test/unit/subagent-control.test.ts`: simulate `transition(undefined → needs_attention)` (event 1 emits), then `transition(needs_attention → undefined)` (no event, but dedup clears), then `transition(undefined → needs_attention)` (event 2 SHOULD emit). Currently event 2 is swallowed; this task makes it pass.

## 10. Doctor surface

- [ ] 10.1 In `doctor.ts`, in the "Control notices" section (introduced by change 1), add `__piSubagentDroppedCoalesceOverflow` count

## 11. Documentation

- [ ] 11.1 Add `## Tuning the watchdog` section to `README.md` (exact heading)
- [ ] 11.2 Section covers `needsAttentionAfterMs`, `coalesceWindowMs`, `notifyOn`, `notifyChannels` with example invocations
- [ ] 11.3 Include a "Restoring the 60s threshold" snippet
- [ ] 11.4 In `skills/pi-subagents/SKILL.md`, add a sub-section titled `Reading control notices` (exact heading) with: prefer `Interrupt` over `Status` for parallel-tasks runs without intercom; wait at least one `coalesceWindowMs` before status-checking

## 12. CHANGELOG

- [ ] 12.1 Add a CHANGELOG entry under the next minor version: threshold default 60→180s (BREAKING-IN-DEFAULT), `coalesceWindowMs` config (default 1000ms), `ControlEvent.lastActivityAt`/`elapsedMs` additive, `SubagentControlMessageDetails.events` (internal renderer payload, not public Details type) additive, hint text update, multi-step renderer

## 13. Tests — unit

- [ ] 13.1 In `test/unit/subagent-control.test.ts`, update default-threshold value to 180_000
- [ ] 13.2 Add tests for `resolveControlConfig coalesceWindowMs` parsing: default, override, global, 0, negative, NaN, non-integer
- [ ] 13.3 Add `formatCoalescedControlNoticeMessage` snapshot tests for N=1 (delegates to single-step), N=3 (multi-step bullets)
- [ ] 13.4 Add tests asserting the `Action:` hint replaces the old `Nudge: no child message route registered` line when intercom is absent
- [ ] 13.5 Add tests for `buildControlEvent` populating `lastActivityAt`/`elapsedMs` correctly when input is provided and absent

## 14. Tests — integration

- [ ] 14.1 New `test/integration/control-notice-coalescing.test.ts`. Use fake timers. Emit three events for one runId within window; advance timer; assert one `pi.sendMessage` call with multi-step content
- [ ] 14.2 Add a test that two different runIds within the window produce two separate notices
- [ ] 14.3 Add a test that `coalesceWindowMs: 0` flushes each event synchronously
- [ ] 14.4 Add a buffer-cap test: 101 events for one runId, flush, assert 100 in notice, `__piSubagentDroppedCoalesceOverflow === 1`
- [ ] 14.5 Add a within-buffer-dedup test: emit live and disk-replay events for same `(runId, index, type)`; assert one bullet
- [ ] 14.6 Add a reload-DROP test: register, fill a buffer, simulate reload (call `previousRuntimeCleanup`), assert NO `pi.sendMessage` was called and `__piSubagentDroppedStaleNotices` incremented by the buffered-event count
- [ ] 14.7 Add a re-stall regression test: stall step 2, flush+publish (epoch 0→1), recover (no event), re-stall step 2, flush+publish (epoch 1→2); assert TWO `pi.sendMessage` calls (the per-runId epoch must allow re-stalls to publish)
- [ ] 14.8 Add a sync-flush time-window test: two events 500ms apart with `coalesceWindowMs: 0` for the same `(runId, index, type)` — second is dropped. Two events 1100ms apart — both publish.
- [ ] 14.9 Add a sync-flush map-eviction test: populate the dedup map, advance time by 60s, fire the sweep, assert old entries are evicted.

## 15. Verification

- [ ] 15.1 Run `npm run test:unit`; all green
- [ ] 15.2 Run `npm run test:integration`; all green
- [ ] 15.3 Manual repro: dispatch a 6-way `subagent({tasks:[...]})` with `control.needsAttentionAfterMs = 5000` to force fast notices, plus deterministic 30s no-output stalls; confirm exactly ONE coalesced notice (not six) appears for the parent
- [ ] 15.4 Verify the README and SKILL.md edits render correctly and contain the exact headings
- [ ] 15.5 `openspec validate improve-control-notice-tuning` reports valid
