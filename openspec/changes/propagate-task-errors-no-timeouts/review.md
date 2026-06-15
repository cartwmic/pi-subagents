# Review

## Modes

| Mode | Value | Notes |
|---|---|---|
| Scale | M | Single capability, ~6 source files + tests. |
| Execution Mode | tdd-preferred | Add/adjust tests alongside each behavioral change; not strictly tdd-required. |
| Verification Mode | retained-recommended | Produce verify-style validator output; not gated. |
| Debug Mode | standard | Bug root cause already established by code reading. |
| Review Status | resolved | Self-review complete; analyze gate READY, zero blockers. |
| Delegation Mode | single-agent | One coherent writer; no subagent fan-out. |
| Worktree Mode | same-tree | Direct edits on integration branch (main). |
| Spec Level | spec-anchored | Specs anchor behavior; code is the source of truth post-apply. |

## Worktree Base SHA

**Worktree Base SHA:** N/A (Worktree Mode = same-tree)

## Manual Adjustments

- Execution Mode = tdd-preferred (not the `standard` default): the bug is
  precisely characterized, so tests are written to pin the corrected
  semantics (partial-result settlement, settle-not-throw, group-kill).
- Delegation Mode = single-agent: changes are tightly coupled across
  `execution.ts` / `parallel-utils.ts` / the three callers; a single writer
  avoids merge/contract churn.

## Execution Notes

- Source files live at the repo root (not `src/`); contracts target
  root-relative globs (e.g. `execution.ts`, not `src/execution.ts`).
- The async path (`subagent-runner.ts`) uses `runSingleStep`/
  `runPiStreaming`, not `runSync`; the same Layer-1/2/3 fixes apply there
  (design D5).
- Layer 1 implemented as `mapSettled` (new in `parallel-utils.ts`) PLUS a
  per-caller `.catch`/try-catch returning `buildFailedSingleResult` (new in
  `types.ts`) at all three callers (executor, chain, runner).
- Layer 3: children now spawn `detached` (POSIX) and abort/forced-termination
  route through `killChildGroup` (new in `post-exit-stdio-guard.ts`);
  `trySignalChild` direct-kill calls were replaced and the now-unused import
  removed from both runners.
- Test harness extended: `mock-pi-script.mjs` gained `grandchildPidFile` +
  `holdOpen` hooks so the abort test reaps a real grandchild, proving
  group-kill (a direct-child kill would leave the grandchild alive).
- Validation: `npm run test:unit` and `npm run test:integration`. The repo
  has 3 pre-existing unit failures (schema/TypeBox + doctor doc string) and
  6 pre-existing integration failures (intercom grouped delivery + fork
  wiring) on `main`, unrelated to this change; this change adds 4 passing
  tests and introduces zero new failures. NOTE: integration tests must run
  with `PI_SUBAGENT_DEPTH`/`PI_SUBAGENT_MAX_DEPTH` unset (the executor depth
  gate blocks nested subagent calls when those are inherited).
