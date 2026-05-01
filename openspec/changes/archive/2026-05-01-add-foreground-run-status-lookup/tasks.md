## 1. Type extensions

- [x] 1.1 In `types.ts:177` (Details interface), add the optional fields: `lookup`, `id`, `runMode`, `currentAgent`, `currentIndex`, `lastActivityAt`, `activityState`, `durationMs`, `terminalState`, `terminatedAt`, `ageSeconds`. All optional.
- [x] 1.2 Keep `mode: "single" | "parallel" | "chain" | "management"` as-is. Add a JSDoc comment clarifying `mode` is the call shape; `runMode` is the run's actual mode.
- [x] 1.3 No new mandatory fields on existing types — purely additive.

## 2. Signature extension

- [x] 2.1 Update `inspectSubagentStatus(params)` → `inspectSubagentStatus(params, state?: SubagentState, globalStore?: Record<string, unknown>)` in `run-status.ts`
- [x] 2.2 The function name remains `inspectSubagentStatus`. Do NOT rename to `runStatus`. All artifact references throughout this change use the real name.
- [x] 2.3 Run `npm run test:unit` to confirm existing tests pass with the new optional parameters (301/303 pass; 2 pre-existing schemas.test.ts failures unrelated)

## 3. Async + results branches gain `details.lookup`

- [x] 3.1 In the async-hit branch, set `details.lookup = "async"` on the response (additive — no other field changes)
- [x] 3.2 In the results-envelope-hit branch, set `details.lookup = "results"`

## 4. Foreground branch

- [x] 4.1 After async/results miss, call `state?.foregroundControls?.get(resolvedId)` (defensive optional chaining). If hit, build the response.
- [x] 4.2 If exact-id misses, perform prefix scan over `state?.foregroundControls?.keys()`. If exactly one key starts with the prefix, use that. If 2+, return ambiguous-prefix error. (Implemented as `findInMapByPrefix` helper.)
- [x] 4.3 Build foreground response with all enrichment fields per Details interface.
- [x] 4.4 Generate content text using relocated `formatForegroundActivity` ("Run/State/Mode/Current/Activity" lines).
- [x] 4.5 Return with `isError: false`

## 5. Recently-terminal branch

- [x] 5.1 Access map via exact key `__piSubagentRecentlyTerminalRuns` (typed read).
- [x] 5.2 Apply lookup-time TTL gate using `RECENT_TERMINAL_TTL_MS` imported from `recent-terminal.ts`.
- [x] 5.3 Prefix scan with TTL filter via `findInMapByPrefix(map, id, stillFresh)`; ambiguity returns error.
- [x] 5.4 Build response with `lookup: "recently-terminal"` and all required fields.
- [x] 5.5 Generate content text per spec.
- [x] 5.6 Return with `isError: false`.

## 6. Relocate `formatForegroundActivity` and `getForegroundControl` to a shared module

- [x] 6.1 Created `foreground-control.ts` exporting `getForegroundControl`, `formatForegroundActivity`, and `ForegroundControl` type.
- [x] 6.2 `subagent-executor.ts` imports both from `foreground-control.ts`; private definitions removed; `interrupt` path uses the shared import.
- [x] 6.3 `run-status.ts` imports both from `foreground-control.ts`.
- [x] 6.4 No circular import — `foreground-control.ts` depends only on `types.ts`.

## 7. Remove executor pre-check

- [x] 7.1 Added `globalStore?: Record<string, unknown>` to `ExecutorDeps`; `index.ts:457` passes `globalStore` (the local alias).
- [x] 7.2 Status branch now: `return inspectSubagentStatus(paramsWithResolvedCwd, deps.state, deps.globalStore);`
- [x] 7.3 Verified: `interrupt` path uses `getForegroundControl` from `foreground-control.ts`.
- [x] 7.4 `foregroundStatusResult` deleted from `subagent-executor.ts`.

## 8. Preserve no-id status semantics (three-tier fallback)

- [x] 8.1 No-id branch implements three-tier fallback via `getForegroundControl(state, undefined)` (which already encodes Tier 1 + Tier 2); falls through to aggregator otherwise.
- [x] 8.2 Aggregator path remains `listAsyncRuns(ASYNC_DIR, ...)` + `formatAsyncRunList` in `run-status.ts`.
- [x] 8.3 Three-tier fallback unit tests added in `test/unit/run-status.test.ts`.
- [x] 8.4 Test that `params.dir` skips foreground/recently-terminal added in `test/unit/run-status.test.ts`.

## 9. CHANGELOG

- [x] 9.1 CHANGELOG entry added under `## [Unreleased]` with Fixed/Added/Changed (BEHAVIOR) sections covering both this change and `fix-control-notice-liveness-gate`.

## 10. Tests — unit

- [x] 10.1 New `test/unit/run-status.test.ts` (20 tests). Covers foreground exact/prefix/ambiguous, recently-terminal TTL gate (within/past, prefix-with-TTL-filter), precedence (foreground beats recently-terminal), no-id three-tier fallback, params.dir bypass, defensive optional chaining (state/globalStore undefined or partial). Async/results disk-fixture cases covered by integration suite.
- [x] 10.2 `details.lookup` presence is asserted in every foreground/recently-terminal/async test.
- [x] 10.3 `details.mode === "management"` for foreground and recently-terminal verified explicitly.
- [x] 10.4 needs_attention propagation test passes.
- [x] 10.5 No-id Tier 3 aggregator test passes (no foreground entries → aggregator path with `mode: "single"`).

## 11. Tests — integration

- [x] 11.1 → 11.4 New `test/integration/run-status-foreground.test.ts` (5 tests, all passing). Covers enriched foreground response, TTL boundary (within / past), the **race-window invariant** (pre-record / post-record-pre-delete / post-delete — never not-found), and the end-to-end `needs_attention` → termination → recently-terminal flow.

## 12. Verification

- [x] 12.1 `npm run test:unit`: 321/323 pass (2 pre-existing schemas.test.ts failures unrelated; +20 new tests from this change all pass)
- [x] 12.2 `npm run test:integration`: pass count includes the 5 new run-status-foreground tests; 5 pre-existing intercom-result-delivery failures unrelated
- [x] 12.3 Manual repro — **deferred** (requires interactive pi harness with long-running subagent). The race-window integration test 11.3 covers the exact interleaving the manual test would surface (pre-record / post-record-pre-delete / post-delete — never not-found).
- [x] 12.4 `openspec validate add-foreground-run-status-lookup` reports valid
