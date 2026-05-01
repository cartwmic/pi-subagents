## 1. Type extensions

- [ ] 1.1 In `types.ts:177` (Details interface), add the optional fields: `lookup`, `id`, `runMode`, `currentAgent`, `currentIndex`, `lastActivityAt`, `activityState`, `durationMs`, `terminalState`, `terminatedAt`, `ageSeconds`. All optional.
- [ ] 1.2 Keep `mode: "single" | "parallel" | "chain" | "management"` as-is. Add a JSDoc comment clarifying `mode` is the call shape; `runMode` is the run's actual mode.
- [ ] 1.3 No new mandatory fields on existing types — purely additive.

## 2. Signature extension

- [ ] 2.1 Update `inspectSubagentStatus(params)` → `inspectSubagentStatus(params, state?: SubagentState, globalStore?: Record<string, unknown>)` in `run-status.ts`
- [ ] 2.2 The function name remains `inspectSubagentStatus`. Do NOT rename to `runStatus`. All artifact references throughout this change use the real name.
- [ ] 2.3 Run `npm run test:unit` to confirm existing tests pass with the new optional parameters

## 3. Async + results branches gain `details.lookup`

- [ ] 3.1 In the async-hit branch, set `details.lookup = "async"` on the response (additive — no other field changes)
- [ ] 3.2 In the results-envelope-hit branch, set `details.lookup = "results"`

## 4. Foreground branch

- [ ] 4.1 After async/results miss, call `state?.foregroundControls?.get(resolvedId)` (defensive optional chaining). If hit, build the response.
- [ ] 4.2 If exact-id misses, perform prefix scan over `state?.foregroundControls?.keys()`. If exactly one key starts with the prefix, use that. If 2+, return ambiguous-prefix error.
- [ ] 4.3 Build foreground response: `details = { lookup: "foreground", id, runMode: control.mode, currentAgent: control.currentAgent, currentIndex: control.currentIndex, lastActivityAt: control.lastActivityAt, activityState: control.currentActivityState, durationMs: Date.now() - control.startedAt, mode: "management", results: [] }`. The `results: []` field is **required** by the `Details` interface (`types.ts:177` declares `results: SingleResult[]`); omitting it is a TS compile error. Note: `control.currentActivityState` is the source field; `activityState` is the response field (rename in mapping). Async/results branches keep their existing `details.mode = "single"`; only foreground/recently-terminal use `"management"`.
- [ ] 4.4 Generate content text: `Run <id> is running (<runMode>); last activity <N>s ago` (use `formatForegroundActivity` once relocated — see Section 6)
- [ ] 4.5 Return with `isError: false`

## 5. Recently-terminal branch

- [ ] 5.1 After foreground miss, access the map via the EXACT key from change 1: `(globalStore as any)?.__piSubagentRecentlyTerminalRuns?.get(resolvedId)`. Use the same key string `__piSubagentRecentlyTerminalRuns`
- [ ] 5.2 Apply lookup-time TTL gate: only treat as hit when `Date.now() - entry.terminatedAt < RECENT_TERMINAL_TTL_MS` (import the constant from `recent-terminal.ts` introduced in change 1)
- [ ] 5.3 If exact-id misses, perform prefix scan over `__piSubagentRecentlyTerminalRuns?.keys()`. Apply the same TTL gate per candidate; ambiguity rule for valid candidates.
- [ ] 5.4 Build response: `details = { lookup: "recently-terminal", id, terminalState, terminatedAt, ageSeconds: Math.floor((now - terminatedAt) / 1000), mode: "management", results: [] }`. `results: []` is required by the `Details` interface.
- [ ] 5.5 Generate content text: `Run <id> ended <ageSeconds>s ago (<terminalState>); full transcript no longer in memory. Inspect the parent tool result for final output.`
- [ ] 5.6 Return with `isError: false`

## 6. Relocate `formatForegroundActivity` and `getForegroundControl` to a shared module

- [ ] 6.1 Create new shared module `foreground-control.ts` containing both helpers:
 - `getForegroundControl(state, runId)` (currently private at `subagent-executor.ts:154`)
 - `formatForegroundActivity(control)` (currently private at `subagent-executor.ts:167`)
 Both `export`ed.
- [ ] 6.2 Update `subagent-executor.ts` to import both from `foreground-control.ts` (replacing the local definitions). The existing call sites for `interrupt` (line 1683) continue working through the shared import.
- [ ] 6.3 Update `run-status.ts` to import both from `foreground-control.ts` for the no-id three-tier fallback (Section 8) and the foreground response builder (Section 4).
- [ ] 6.4 Avoid the circular import that exporting from `subagent-executor.ts` would have caused.

## 7. Remove executor pre-check

- [ ] 7.1 Add a `globalStore` field to `ExecutorDeps` interface (in `subagent-executor.ts` types). Update the deps construction in `index.ts` (the site that calls `registerSubagentExtension`'s setup path) to pass `globalThis as Record<string, unknown>` (or a captured reference to the global store object).
- [ ] 7.2 At `subagent-executor.ts:1676-1678`, replace the body of the `params.action === "status"` branch with `return inspectSubagentStatus(paramsWithResolvedCwd, deps.state, deps.globalStore);`
- [ ] 7.3 (Replaced by Section 6.) `getForegroundControl` already lives in `foreground-control.ts`; the executor's `interrupt` path imports from there. No additional export step needed.
- [ ] 7.4 Delete `foregroundStatusResult` from `subagent-executor.ts` (no longer called).

## 8. Preserve no-id status semantics (three-tier fallback)

- [ ] 8.1 At the top of `inspectSubagentStatus`, if both `params.id` and `params.runId` are absent, implement the three-tier fallback that mirrors `getForegroundControl(state, undefined)` at `subagent-executor.ts:154-165`:
 - **Tier 1**: if `state?.lastForegroundControlId` is non-null AND `state.foregroundControls.has(state.lastForegroundControlId)`, build and return the foreground response.
 - **Tier 2**: scan `state?.foregroundControls?.values()` and pick the entry with the largest `updatedAt`. If non-null, build and return its foreground response.
 - **Tier 3**: fall through to the existing aggregator path in `run-status.ts`.
- [ ] 8.2 Find the existing aggregator code path in `run-status.ts` (NOT `subagents-status.ts` — that file is the TUI overlay component, not a reusable status aggregator). Verify the call.
- [ ] 8.3 Add unit tests for all three tiers: (a) tier 1 hit; (b) tier 2 hit when `lastForegroundControlId` is null but foreground has entries; (c) tier 2 picks newest by `updatedAt` with multiple entries; (d) tier 3 aggregator returned when none.
- [ ] 8.4 Also test that `params.dir` skips the foreground/recently-terminal branches entirely (resolution proceeds via dir directly).

## 9. CHANGELOG

- [ ] 9.1 Add a CHANGELOG entry under the next minor version: `inspectSubagentStatus` now resolves foreground and recently-terminal runs; recently-terminal returns `isError: false` (was `isError: true` previously); callers branching on `isError === true` for "run gone" should switch to `details.lookup === "recently-terminal"`. Backward-compatible for all previous successful response shapes.

## 10. Tests — unit

- [ ] 10.1 New `test/unit/run-status.test.ts`. (This file does not yet exist; this change creates it.) Cover: each of the four hit paths, all-miss path, precedence (id in async + foreground returns async-shaped), foreground prefix resolution, foreground ambiguous-prefix error, recently-terminal TTL gate (within and past), defensive optional chaining (state/globalStore undefined or partial)
- [ ] 10.2 Test that `details.lookup` is present on every successful response
- [ ] 10.3 Test that `details.mode === "management"` for foreground and recently-terminal hits; `details.mode === "single"` for async and results hits (preserving today's behavior)
- [ ] 10.4 Test that a foreground hit with `currentActivityState === "needs_attention"` produces `details.activityState === "needs_attention"`
- [ ] 10.5 Test no-id path returns aggregator overview

## 11. Tests — integration

- [ ] 11.1 New `test/integration/run-status-foreground.test.ts`. Register a fake foreground control, query, assert foreground-shaped response with all enrichment fields populated
- [ ] 11.2 Register a recently-terminal entry, query within TTL, assert recently-terminal response. Advance time past TTL, query again, assert not-found
- [ ] 11.3 Race-window test: simulate change-1's `recordTerminalRun` then `foregroundControls.delete` ordering; query at each interleaving point; assert the response is always either foreground OR recently-terminal, never not-found
- [ ] 11.4 End-to-end "control notice → status query": fire a `needs_attention` for a live run, dispatch the status query, assert foreground response with `activityState: "needs_attention"`. Let the run end (via change-1's terminal recording), query again, assert recently-terminal response

## 12. Verification

- [ ] 12.1 Run `npm run test:unit`; all green
- [ ] 12.2 Run `npm run test:integration`; all green
- [ ] 12.3 Manual repro: dispatch a long-running `subagent({agent: "<name>", task: "<long task>"})`, query `subagent({action:"status", id: <runId>})` mid-run; confirm foreground response with `activityState`, `runMode`, `lastActivityAt`. Allow the run to complete; query immediately; confirm recently-terminal. Wait 35s; query; confirm "Async run not found"
- [ ] 12.4 `openspec validate add-foreground-run-status-lookup` reports valid
