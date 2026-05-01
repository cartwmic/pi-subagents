## Context

`subagent({action:"status", id:R})` resolution today is split:

1. **Executor pre-check** (`subagent-executor.ts:1676-1678`):
   ```
   if (params.action === "status") {
     const foreground = getForegroundControl(deps.state,
       paramsWithResolvedCwd.id ?? paramsWithResolvedCwd.runId);
     if (foreground) return foregroundStatusResult(foreground);
     return inspectSubagentStatus(paramsWithResolvedCwd);
   }
   ```
   This makes foreground precedence *first*. The response shape is
   sparse: `details: { mode: "management", results: [] }` — no run-
   mode, no activity timing, no agent name.

2. **`run-status.ts:inspectSubagentStatus`** — Resolves async dir
   (`ASYNC_DIR`) and results envelopes (`RESULTS_DIR/*.json`).
   Returns `"Async run not found"` for everything else.

3. **No recently-terminal branch.** A run that just ended is
   indistinguishable from one that never existed.

After `fix-control-notice-liveness-gate`, `globalStore.
recentlyTerminalRuns` exists with entries `{terminatedAt,
terminalState}` populated at the transition moment, with a TTL of
30s. This change consumes that map.

The function is named `inspectSubagentStatus` (not `runStatus`).
This whole change uses the real name; round-1 reviewers correctly
flagged the inconsistency.

## Goals / Non-Goals

**Goals:**

- A status query returns a useful answer for live foreground runs,
  recently-terminal runs (within TTL), and the existing async/results
  cases. Truly-unknown ids still return the existing not-found error.
- Lookup precedence is async > results > foreground > recently-
  terminal, with `details.lookup` as a discriminator on every hit.
- The foreground response enriches what `foregroundStatusResult`
  returned today — adds `runMode`, `lastActivityAt`, `activityState`,
  `durationMs`, plus the new `lookup` discriminator and `id`.
- Recently-terminal lookups are gated by a lookup-time TTL check
  (presence in the map alone is not freshness — sweep cadence ≠ TTL).
- Foreground and recently-terminal lookups support prefix expansion.
- All previous successful response shapes remain backward compatible
  (gain `details.lookup` as an additive field).

**Non-Goals:**

- Updating `formatControlNoticeMessage` to point at a different
  command. The notice text already says `Status: subagent({action:
  "status", id:...})` and that command will simply now answer
  better.
- IPC across processes. `globalStore` is the in-process source.
- Listing all live runs (the existing `subagents-status` aggregator
  already does that; out of scope).

## Decisions

### Decision 1: Remove the executor pre-check; consolidate in `inspectSubagentStatus`

**Choice:** Replace `subagent-executor.ts:1676-1678` with:
```
if (params.action === "status") {
  return inspectSubagentStatus(paramsWithResolvedCwd, deps.state,
    globalStore);
}
```
Remove `foregroundStatusResult` (no longer called). Keep
`getForegroundControl` (still used by the `interrupt` path at
`subagent-executor.ts:1683`).

**Why:** The pre-check is what causes the precedence inversion. Round-1
reviewers caught that the new spec scenarios cannot pass while the pre-
check exists. Removing it is the cleanest path. The existing no-id
behavior of `action:"status"` (return latest foreground or aggregate)
is preserved by `inspectSubagentStatus` itself — see Decision 6.

**Alternative considered:** Keep the pre-check, add a richer foreground
response inside it. Rejected — duplicates the new lookup logic in two
places and forever inverts precedence.

### Decision 2: Lookup precedence — async > results > foreground > recently-terminal

**Choice:** Resolve in this order; stop at first hit.

1. `ASYNC_DIR` — exact id or prefix (existing `findByPrefix`).
2. `RESULTS_DIR/*.json` — exact id or prefix.
3. `state.foregroundControls` — exact id, then prefix scan over keys.
4. `globalStore.__piSubagentRecentlyTerminalRuns` — exact id, then prefix scan,
   then `now - terminatedAt < RECENT_TERMINAL_TTL_MS`.

**Why this order:** Async has the canonical disk-backed transcript;
results envelopes are persisted snapshots. Both are durable
historical records. Foreground is transient in-memory state.
Recently-terminal is the most ephemeral. If a runId somehow lives in
multiple stores (rare; could happen across reload races), the most
durable answer wins.

**Alternative considered:** Foreground first (today's behavior).
Rejected per round-1 reviewer feedback — async is the canonical
record; precedence should match that.

### Decision 3: `Details` interface gains optional fields

**Choice:** Extend `Details` in `types.ts:177` with:
```ts
lookup?: "async" | "results" | "foreground" | "recently-terminal";
id?: string;
runMode?: "single" | "parallel" | "chain";
currentAgent?: string;
currentIndex?: number;
lastActivityAt?: number;
activityState?: ActivityState;
durationMs?: number;
terminalState?: "succeeded" | "failed" | "interrupted";
terminatedAt?: number;
ageSeconds?: number;
```
Keep `mode: "single" | "parallel" | "chain" | "management"` — its
existing semantic is "the call shape" (status/management calls return
`mode: "management"` today). `runMode` carries the *run's* mode for
foreground hits.

**Why split `mode` and `runMode`:** Round-1 reviewer flagged the
collision: today's `Details.mode === "management"` for status responses
is consumed by callers that branch on it. Putting the run mode on
`runMode` preserves backward compat.

**Why all fields optional:** A single response shape that grows by
addition is a smaller change than introducing a discriminated union;
unused fields are simply absent.

### Decision 4: Lookup-time TTL gate on recently-terminal

**Choice:** A recently-terminal hit is valid only when both:
1. `globalStore.__piSubagentRecentlyTerminalRuns.has(id)`, AND
2. `Date.now() - entry.terminatedAt < RECENT_TERMINAL_TTL_MS` (30s).

If presence holds but TTL has expired, treat as miss (continue to
not-found).

**Why:** The change-1 sweep runs every 60s with a 30s TTL. Without a
lookup-time check, a query 31–90s after termination would see the
unswept entry and return a stale answer. Round-1 reviewer caught this.

### Decision 5: Foreground/recently-terminal prefix resolution

**Choice:** Apply the same prefix-expansion logic that `findByPrefix`
already provides for async/results. Implementation: linear scan over
map keys (sub-millisecond for sub-1000 entries). On ambiguous prefix
(2+ matches), return an error message: `"Ambiguous id prefix '<p>'.
Use the full id."` with `isError: true`.

**Why:** The notice text always emits the full runId, so the common
case works without prefix logic. But users who shorten ids manually
should get the same UX as for async/results.

### Decision 6: Preserve no-id status semantics

**Choice:** When `params.id` and `params.runId` are both absent,
`inspectSubagentStatus` falls back to the existing aggregator behavior
(returns the live status overview from `subagents-status.ts`). No
change in shape.

**Why:** `README.md` documents `subagent({action:"status"})` (no id)
as a valid call. Don't regress.

### Decision 7: Relocate `formatForegroundActivity` to shared scope

**Choice:** `formatForegroundActivity` (currently private to
`subagent-executor.ts:167`) moves to `run-status.ts` (or is re-
exported). `subagent-executor.ts` keeps its current usage by importing
the shared version.

**Why:** Avoids duplication. Round-1 reviewer caught the implicit
import.

## Risks / Trade-offs

- **[Risk] Removing the executor pre-check changes the call path's
  observable side effects** → Mitigation: `inspectSubagentStatus`
  with `state` and `globalStore` covers the same lookups
  symmetrically. Add an integration test that an id present in
  foreground returns a non-error status, same as today (with richer
  details).

- **[Risk] Race between change-1's `recordTerminalRun(...)` and
  `foregroundControls.delete(...)` ordering** → Mitigation: change-1
  spec mandates `recordTerminalRun` BEFORE `delete`. This change
  asserts that ordering in an integration test (record-then-delete,
  query in between, expect either foreground hit OR recently-terminal
  hit, never not-found).

- **[Risk] Defensive optional chaining required on test inputs** →
  Mitigation: every `state?.foregroundControls?.get(...)` and
  `globalStore?.recentlyTerminalRuns?.get(...)` uses optional chaining
  so partial mocks don't throw.

- **[Trade-off] `isError: false` for terminal lookups changes the
  signal** → Documented in CHANGELOG. Callers branching on `isError
  === true` for "run gone" should switch to `details.lookup ===
  "recently-terminal"`.

- **[Risk] `formatForegroundActivity` relocation breaks something
  unforeseen** → Mitigation: it's a small private helper; relocate +
  test the same way it's used today.

## Migration Plan

1. Land after `fix-control-notice-liveness-gate` so
   `globalStore.__piSubagentRecentlyTerminalRuns` is populated.
2. Implement order: extend `Details` first (compile-clean foundation),
   then `inspectSubagentStatus` signature, then the four lookup
   branches, then remove the pre-check, then add CHANGELOG entry.
3. Manual verification: trigger a long-running foreground run, query
   status mid-run (foreground response with `activityState`), let it
   end, query immediately (recently-terminal), wait past TTL, query
   (not-found).
4. No flag required.

## Open Questions

(All round-1 open questions resolved in this revision: function name
is `inspectSubagentStatus`, prefix-expansion policy is "exact-then-
prefix-then-ambiguous-error", `mode`/`runMode` split is settled.)

- Should the recently-terminal response include the `runMode` of the
  run if it's available in the entry? Currently the entry is
  `{terminatedAt, terminalState}` only. Probably yes; cheap to add to
  `recordTerminalRun` (capture the runMode from the foreground
  control or async job at recording time). Tracked in tasks; non-
  blocking.
