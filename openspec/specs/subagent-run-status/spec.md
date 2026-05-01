# subagent-run-status Specification

## Purpose
TBD - created by archiving change add-foreground-run-status-lookup. Update Purpose after archive.
## Requirements
### Requirement: `inspectSubagentStatus` SHALL accept optional `state` and `globalStore` parameters

The exported function SHALL be `inspectSubagentStatus(params, state?: SubagentState, globalStore?: Record<string, unknown>)`. Existing callers passing only `params` SHALL continue to function (resolving against async and results stores only). The function name SHALL NOT be renamed; all artifact references in this change use `inspectSubagentStatus`. When `params.dir` is provided, the foreground and recently-terminal branches SHALL NOT be consulted; resolution proceeds via `dir → async-dir-load → not-found` (preserving existing `params.dir` semantics).

#### Scenario: `params.dir` skips foreground and recently-terminal
- **WHEN** `inspectSubagentStatus({dir: "/tmp/some/path"}, state, globalStore)` is called
- **THEN** the function loads the directory directly; foreground and recently-terminal branches are NOT consulted regardless of state contents

#### Scenario: Legacy single-arg call resolves async only
- **WHEN** a caller invokes `inspectSubagentStatus(params)` (no state, no globalStore)
- **THEN** the function resolves against `ASYNC_DIR` and `RESULTS_DIR` only and returns the existing not-found error if neither matches

#### Scenario: Three-arg call enables foreground and recently-terminal lookups
- **WHEN** a caller invokes `inspectSubagentStatus(params, state, globalStore)`
- **THEN** the function additionally resolves against `state.foregroundControls` and `globalStore.__piSubagentRecentlyTerminalRuns`

### Requirement: Status resolution SHALL follow async > results > foreground > recently-terminal precedence

The lookup SHALL consult four stores in fixed order, stopping at the first match: (1) `ASYNC_DIR` exact-then-prefix; (2) `RESULTS_DIR/*.json` exact-then-prefix; (3) `state.foregroundControls` exact-then-prefix; (4) `globalStore.__piSubagentRecentlyTerminalRuns` exact-then-prefix. Only when all four miss SHALL the function return `isError: true` with content `"Async run not found. Provide id or dir."`.

#### Scenario: Async hit returns first when id is in multiple stores
- **WHEN** id `R` exists in `ASYNC_DIR` and is also present in `state.foregroundControls`
- **THEN** the response is the async-shaped response with `details.lookup === "async"`
- **AND** foreground is not consulted

#### Scenario: Foreground hit when async and results miss
- **WHEN** id `R` is not in `ASYNC_DIR`, not in `RESULTS_DIR`, but is in `state.foregroundControls`
- **THEN** the foreground response is returned with `details.lookup === "foreground"`

#### Scenario: Recently-terminal hit when first three miss and TTL valid
- **WHEN** id `R` misses async, results, foreground; is in `globalStore.__piSubagentRecentlyTerminalRuns`; AND `Date.now() - entry.terminatedAt < RECENT_TERMINAL_TTL_MS`
- **THEN** the recently-terminal response is returned with `details.lookup === "recently-terminal"`

#### Scenario: Recently-terminal entry past TTL is treated as miss
- **WHEN** id `R` misses async, results, foreground; is in `globalStore.__piSubagentRecentlyTerminalRuns`; BUT `Date.now() - entry.terminatedAt >= RECENT_TERMINAL_TTL_MS`
- **THEN** the function returns the not-found error (not-found `isError: true`)

#### Scenario: All four miss
- **WHEN** id `R` is in none of the four stores
- **THEN** the function returns `isError: true` with content `"Async run not found. Provide id or dir."`

### Requirement: Foreground response SHALL include enriched run progress fields and required `results` field

When the foreground branch hits, the response SHALL be `isError: false`. The `details` object SHALL include `lookup === "foreground"`, `id`, `runMode` ∈ `{"single", "parallel", "chain"}`, `mode: "management"`, **`results: []`** (the `Details` interface at `types.ts:177` declares `results: SingleResult[]` as required — omitting it is a TypeScript compile error), and the optional fields `currentAgent`, `currentIndex`, `lastActivityAt`, `activityState`, `durationMs` populated from the foreground control object. Async and results hits SHALL preserve their existing `details.mode` value (`"single"` per `run-status.ts`'s current implementation) — only `details.lookup` is added there. The cross-store discriminator is `details.lookup`; `details.mode` is per-branch. The content text SHALL include a one-line human summary similar to `Run <id> is running (<runMode>); last activity <N>s ago.`

#### Scenario: Foreground response for a single run mid-execution
- **WHEN** a foreground lookup hits a `mode: "single"` control whose `lastActivityAt` is 5 seconds ago
- **THEN** `details.lookup === "foreground"`, `details.runMode === "single"`, `details.mode === "management"`, `details.lastActivityAt` matches the timestamp, and the content text mentions "5s ago"

#### Scenario: Foreground response for parallel batch
- **WHEN** a foreground lookup hits a `mode: "parallel"` control with `currentIndex = 2`
- **THEN** `details.runMode === "parallel"` and `details.currentIndex === 2`

#### Scenario: Foreground hit reports needs_attention activity state
- **WHEN** the foreground control's `currentActivityState === "needs_attention"`
- **THEN** `details.activityState === "needs_attention"` and the content text indicates the run is currently flagged

#### Scenario: `mode === "management"` is preserved on foreground responses
- **WHEN** any foreground hit is returned
- **THEN** consumers branching on `details.mode === "management"` continue to route the response correctly

### Requirement: Recently-terminal response SHALL be non-error, TTL-gated, and include required `results` field

When the recently-terminal branch hits AND the TTL gate passes (`now - terminatedAt < RECENT_TERMINAL_TTL_MS`), the response SHALL be `isError: false`. The `details` object SHALL include `lookup === "recently-terminal"`, `id`, `terminalState` ∈ `{"succeeded", "failed", "interrupted"}`, `terminatedAt`, `ageSeconds`, `mode: "management"`, and **`results: []`** (the `Details` interface declares `results: SingleResult[]` as required). The content text SHALL include a hint that full transcript is no longer in memory and that the parent tool result holds the run's final output.

#### Scenario: Succeeded terminal response
- **WHEN** id `R` is in `recentlyTerminalRuns` with `terminalState: "succeeded"` and `terminatedAt` 10 seconds ago
- **THEN** `details.terminalState === "succeeded"`, `details.ageSeconds === 10`, and `isError === false`

#### Scenario: Failed terminal response
- **WHEN** id `R` is in `recentlyTerminalRuns` with `terminalState: "failed"`
- **THEN** `details.terminalState === "failed"` and the content text mentions failure

#### Scenario: Interrupted terminal response
- **WHEN** id `R` is in `recentlyTerminalRuns` with `terminalState: "interrupted"`
- **THEN** `details.terminalState === "interrupted"`

#### Scenario: TTL-expired terminal entry returns not-found
- **WHEN** id `R` is in `recentlyTerminalRuns` with `terminatedAt` 35 seconds ago and TTL is 30s
- **THEN** the response is the existing not-found error with `isError: true`

### Requirement: Async and results responses SHALL gain a `details.lookup` discriminator while preserving `details.mode`

To make all four lookup paths uniformly inspectable, async hits SHALL set `details.lookup = "async"` and results hits SHALL set `details.lookup = "results"`. All other existing fields in those response shapes — INCLUDING `details.mode` (which currently is `"single"` for both branches) — SHALL be preserved unchanged. The cross-store discriminator is `details.lookup`, not `details.mode`.

#### Scenario: Async hit carries discriminator
- **WHEN** an async-store hit produces a response
- **THEN** `details.lookup === "async"` and all other existing fields are unchanged

#### Scenario: Results hit carries discriminator
- **WHEN** a results-envelope hit produces a response
- **THEN** `details.lookup === "results"` and all other existing fields are unchanged

### Requirement: Foreground and recently-terminal lookups SHALL support prefix expansion

Both branches SHALL apply prefix expansion equivalent to the existing `findByPrefix` algorithm: an exact key match wins; otherwise, if exactly one key starts with the prefix, that key resolves. If two or more keys share the prefix, the function SHALL return `isError: true` with content `"Ambiguous id prefix '<p>'. Use the full id."`.

#### Scenario: Unique foreground prefix resolves
- **WHEN** `state.foregroundControls` contains a single key starting with `"532c"` and the user passes `id: "532c"`
- **THEN** the foreground branch resolves to that entry and returns the foreground response

#### Scenario: Ambiguous foreground prefix is rejected
- **WHEN** `state.foregroundControls` contains keys `"532cabcd"` and `"532cef01"` and the user passes `id: "532c"`
- **THEN** the function returns `isError: true` with content matching `"Ambiguous id prefix '532c'. Use the full id."`

#### Scenario: Recently-terminal prefix resolves
- **WHEN** `globalStore.__piSubagentRecentlyTerminalRuns` contains a single key starting with `"abc"` and the user passes `id: "abc"`
- **AND** the entry's TTL is still valid
- **THEN** the recently-terminal branch resolves to that entry

### Requirement: Defensive optional chaining SHALL be used for state and globalStore lookups

Every access to `state` substructures and `globalStore` substructures SHALL use optional chaining: `state?.foregroundControls?.get(...)`, `(globalStore?.__piSubagentRecentlyTerminalRuns as Map<string, ...> | undefined)?.get(...)`. A partial mock supplying `state` without `foregroundControls` (or `globalStore` without `__piSubagentRecentlyTerminalRuns`) SHALL NOT throw — the branches SHALL behave as if the substore is empty.

#### Scenario: state is undefined
- **WHEN** `inspectSubagentStatus(params, undefined, undefined)` is called
- **THEN** only async and results branches are consulted; no exception

#### Scenario: state present but foregroundControls missing
- **WHEN** `inspectSubagentStatus(params, {} as SubagentState, undefined)` is called
- **THEN** the foreground branch behaves as a miss (no exception)

#### Scenario: globalStore present but `__piSubagentRecentlyTerminalRuns` missing
- **WHEN** `inspectSubagentStatus(params, state, {})` is called
- **THEN** the recently-terminal branch behaves as a miss (no exception)

### Requirement: Executor pre-check for `action:"status"` SHALL be removed

`subagent-executor.ts:1676-1678` SHALL no longer short-circuit `action:"status"` via `getForegroundControl`/`foregroundStatusResult`. The status branch SHALL call `inspectSubagentStatus(paramsWithResolvedCwd, deps.state, globalStore)` directly. `getForegroundControl` SHALL remain exported because the `interrupt` path at `subagent-executor.ts:1683` continues to use it.

#### Scenario: Status routes through inspectSubagentStatus
- **WHEN** the executor receives `params.action === "status"`
- **THEN** it calls `inspectSubagentStatus(paramsWithResolvedCwd, deps.state, globalStore)` and returns the result directly

#### Scenario: foregroundStatusResult is no longer called
- **WHEN** any code path is exercised that previously hit `foregroundStatusResult`
- **THEN** the equivalent foreground response now comes from `inspectSubagentStatus`

#### Scenario: Interrupt path still uses getForegroundControl
- **WHEN** the executor receives `params.action === "interrupt"`
- **THEN** the existing `getForegroundControl(deps.state, targetRunId)` lookup at line 1683 still runs

### Requirement: No-id status calls SHALL preserve today's three-tier fallback

When `params.id` and `params.runId` are both absent, `inspectSubagentStatus` SHALL preserve today's three-tier fallback used by `getForegroundControl(state, undefined)` (`subagent-executor.ts:154-165`):

1. **Tier 1**: if `state.lastForegroundControlId` is non-null AND `state.foregroundControls.has(state.lastForegroundControlId)`, return the foreground response for that control.
2. **Tier 2**: otherwise, scan `state.foregroundControls.values()` and pick the entry with the largest `updatedAt` (newest). If a non-null result exists, return its foreground response.
3. **Tier 3**: only if both tiers miss, fall through to the existing aggregator behavior in `run-status.ts`.

This preserves the documented `subagent({action:"status"})` no-id behavior. Round-3 review identified that limiting to tier 1 alone regresses today's behavior when `lastForegroundControlId` was reset (e.g., by a previous run's terminal cleanup at `subagent-executor.ts:1883-1884`) but a different concurrent foreground run still exists.

#### Scenario: Tier 1 — no-id status returns latest by lastForegroundControlId
- **WHEN** `state.lastForegroundControlId === "R"` and `state.foregroundControls.has("R")`
- **AND** `inspectSubagentStatus({action:"status"}, state, globalStore)` is called
- **THEN** the response is the foreground response for run `R`

#### Scenario: Tier 2 — no-id falls through to newest foreground when lastForegroundControlId is null
- **WHEN** `state.lastForegroundControlId === null` AND `state.foregroundControls` contains one entry `R2` with `updatedAt = 1234`
- **AND** `inspectSubagentStatus({action:"status"}, state, globalStore)` is called
- **THEN** the response is the foreground response for `R2`

#### Scenario: Tier 2 — newest by updatedAt picks correctly with multiple entries
- **WHEN** `state.lastForegroundControlId === null` AND `foregroundControls` contains `R1 (updatedAt=100)` and `R2 (updatedAt=200)`
- **THEN** the response is the foreground response for `R2`

#### Scenario: Tier 3 — aggregator overview when no foreground exists
- **WHEN** `state.lastForegroundControlId === null` AND `state.foregroundControls` is empty
- **THEN** the response is the aggregator overview, equivalent to today's no-id behavior

(Scenarios are above under the three-tier requirement.)

### Requirement: `formatForegroundActivity` SHALL be relocated to shared scope

The helper currently private to `subagent-executor.ts:167` SHALL be moved to a shared module (or re-exported from one) so `inspectSubagentStatus` can render foreground activity text without duplication. `subagent-executor.ts` SHALL import the shared version where it currently uses the local one.

#### Scenario: Helper is reusable
- **WHEN** both `subagent-executor.ts` and `run-status.ts` need to format foreground activity
- **THEN** both import the same `formatForegroundActivity` symbol from a shared module

