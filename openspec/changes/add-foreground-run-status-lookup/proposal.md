## Why

Today's `subagent({action: "status", id: R})` flow is split between
`subagent-executor.ts:1676-1678` (which short-circuits for foreground
runs via `getForegroundControl`/`foregroundStatusResult`) and
`run-status.ts:inspectSubagentStatus` (which only looks up async
directories and persisted result envelopes). This split has three
practical problems:

1. **Wrong precedence.** Foreground is checked *before* async, so a
 runId that ended up in both stores returns the foreground shape
 even though the async directory has the canonical record.
2. **Impoverished foreground response.** `foregroundStatusResult`
 returns `details: { mode: "management", results: [] }` — no
 `runMode`, no `lastActivityAt`, no `activityState`, no
 `durationMs`. A parent reacting to a control notice gets nearly
 nothing useful.
3. **No recently-terminal answer.** When the
 `fix-control-notice-liveness-gate` change drops a stale notice, the
 parent might still call `status` to confirm. Today that returns
 "Async run not found" — the same dead-end that motivated the
 liveness change in the first place.

This change consolidates status lookup into `inspectSubagentStatus`,
removes the executor pre-check, fixes precedence to async > results >
foreground > recently-terminal, enriches the foreground response, and
adds a recently-terminal branch with a lookup-time TTL gate.

## What Changes

- **Remove** the foreground pre-check at `subagent-executor.ts:1676-
 1678`; route `action:"status"` through `inspectSubagentStatus(params,
 deps.state, globalStore)`. Keep `getForegroundControl` exported for
 the existing `interrupt` path that also uses it.
- **Extend** `inspectSubagentStatus` signature to `(params,
 state?: SubagentState, globalStore?: Record<string, unknown>)` so
 legacy callers (and tests) continue to work; in those calls only
 the async/results branches resolve.
- **Extend** `Details` interface in `types.ts:177` with optional
 fields: `lookup`, `id`, `runMode`, `currentAgent`, `currentIndex`,
 `lastActivityAt`, `activityState`, `durationMs`, `terminalState`,
 `terminatedAt`, `ageSeconds`. Keep `mode` as-is (`"single" |
 "parallel" | "chain" | "management"`) — `"management"` continues to
 describe the *call shape*; `runMode` carries the run's mode.
- **Implement** four-store lookup in `inspectSubagentStatus`:
 1. Async directory (existing, unchanged response shape including
 `details.mode`; gain `details.lookup = "async"`)
 2. Results envelope (existing, unchanged response shape; gain
 `details.lookup = "results"`)
 3. Foreground (new branch; defensive `state?.foregroundControls?.get`).
 Sets `details.mode = "management"` (matches today's
 foreground-status response) and `details.runMode = control.mode`
 4. Recently-terminal with **lookup-time TTL check**: present in
 `globalStore.__piSubagentRecentlyTerminalRuns` (exact key from
 change 1) AND `now - entry.terminatedAt < RECENT_TERMINAL_TTL_MS`.
 Sets `details.mode = "management"`.
- **Resolve prefix** for foreground/terminal: if the user passed a
 prefix that uniquely matches one entry in foreground or recently-
 terminal, accept it. Same algorithm as `findByPrefix` in
 `run-status.ts:53` but operating on map keys.
- **Relocate** `formatForegroundActivity` from `subagent-executor.ts`
 (private) to a shared module (or re-export it) so
 `inspectSubagentStatus` can use it without duplication.
- **Document** in CHANGELOG that recently-terminal returns `isError:
 false` (a behavior change for callers branching on `isError === true`
 for "run gone" cases — the truly-not-found case still returns
 `isError: true`).
- **Preserve no-id `action:"status"` semantics**: today's flow returns
 the latest foreground run when no `id`/`runId` is supplied (via
 `getForegroundControl` consulting `state.lastForegroundControlId`).
 This change preserves that: when no id is provided,
 `inspectSubagentStatus` first checks for any current foreground
 control (latest by `state.lastForegroundControlId`); only if none
 exists does it fall through to the existing aggregator path in
 `run-status.ts`.

## Capabilities

### New Capabilities

- `subagent-run-status`: Defines the consolidated lookup contract for
 `action:"status"` across all four run-state stores, the precedence
 order, the `details.lookup` discriminator, and the response shapes
 (including the foreground enrichment and recently-terminal new
 branch).

### Modified Capabilities

(none.)

## Impact

- **Code**:
 - `subagent-executor.ts` — remove pre-check (lines 1676-1678);
 relocate / export `formatForegroundActivity`; route status through
 `inspectSubagentStatus(params, deps.state, globalStore)`. `interrupt`
 path keeps `getForegroundControl` (still used). `getForegroundControl`
 is currently a private helper at `subagent-executor.ts:154` — export
 it from that file or move to a shared module so `run-status.ts` can
 reuse the same lookup logic for the no-id and lastForegroundControlId
 paths.
 - `globalStore` plumbing into the executor: add a `globalStore` field
 to `ExecutorDeps` (parallel to `state`) and pass it from the
 extension setup site in `index.ts` where `deps` is constructed.
 - `run-status.ts` — extend signature, add foreground + recently-
 terminal branches with prefix expansion and TTL gate; add
 `details.lookup` to async/results responses.
 - `types.ts` — extend `Details` with optional fields above.
 - `index.ts` — verify no caller of `inspectSubagentStatus` needs
 updating; confirm import is still used (it is, indirectly through
 executor — verify).
 - `CHANGELOG.md` — note the `isError` semantic change for terminal
 lookups under the next minor version.
- **Tests**: new `test/unit/run-status.test.ts` covering all four hit
 paths, precedence, prefix resolution, TTL gate, defensive optional
 chaining when `state`/`globalStore` are undefined. New
 `test/integration/run-status-foreground.test.ts` end-to-end.
- **Public API**: `inspectSubagentStatus` gains optional parameters
 (backward compatible). `Details` gains optional fields (backward
 compatible). The `isError` change for terminal lookups is a behavior
 change but only affects the previously-non-existent case.
- **Dependency**: requires `fix-control-notice-liveness-gate` applied
 first (uses `globalStore.__piSubagentRecentlyTerminalRuns`).
- **Risk**: low. Lookup behavior strictly improves — every previous
 successful path still returns the same shape (with one new
 discriminator field that consumers can ignore).
