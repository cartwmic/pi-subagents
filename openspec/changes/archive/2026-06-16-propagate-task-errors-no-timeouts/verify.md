# Verify

**Generated:** 2026-06-14 by worker (Claude), openspec-apply-change
**Change:** propagate-task-errors-no-timeouts

## Completion Decision

**Status:** green

## Checks

| # | Check | Status | Details |
|---|---|---|---|
| 1 | Structural validation (`openspec validate --strict`) | pass | "Change 'propagate-task-errors-no-timeouts' is valid" |
| 2 | Task completion (zero `- [ ]` in tasks.md) | pass | 0 unchecked / 15 checked |
| 3 | Delta vs current spec coherence | pass | New capability `subagent-parallel-recovery`; no MODIFIED/REMOVED of existing specs; no overlap with subagent-control-notice/-tuning/-run-status |
| 4 | Commit hygiene (subject ≤72; body explains why) | pass | `docs(openspec): …` (64) and `fix(parallel): …` (62); both bodies state the WHY (the hang + recovery model) |
| 5 | AC↔test mapping (canonical IDs) | pass | 5/5 ACs forward-covered; changed test files reference AC IDs (below) |
| 6 | Constitution compliance audit (all changed files) | pass | I–IV upheld (below) |

## Check 5 detail — AC↔test mapping (canonical ID format)

### Forward coverage (each AC has ≥1 test)

| AC ID | Test references | Status |
|---|---|---|
| subagent-parallel-recovery.failed-task-settles-as-partial-result | test/integration/parallel-execution.test.ts ("one task fails in a batch…", "a throwing per-task run settles…") | covered |
| subagent-parallel-recovery.concurrency-pool-settles-not-throws | test/unit/parallel-utils.test.ts (mapSettled suite); test/integration/parallel-execution.test.ts ("settles with partials…") | covered |
| subagent-parallel-recovery.error-terminal-message-settles-promptly | test/integration/parallel-execution.test.ts ("a child that emits an error-terminal then holds open settles via the drain…", 5.0s = drain-driven) | covered |
| subagent-parallel-recovery.abort-propagates-to-process-group | test/integration/parallel-execution.test.ts ("aborting a running task reaps the child process group (incl grandchild)…") | covered |
| subagent-parallel-recovery.no-liveness-or-wedge-timeout | test/integration/parallel-execution.test.ts (abort test 2nd citation: held-open child never self-terminates on a clock; only cancel reaps it) | covered |

### Reverse coverage (each changed test references ≥1 AC)

| Test file | AC references | Status |
|---|---|---|
| test/unit/parallel-utils.test.ts | concurrency-pool-settles-not-throws | referenced |
| test/integration/parallel-execution.test.ts | all 5 subagent-parallel-recovery.* IDs | referenced |
| test/support/mock-pi-script.mjs, mock-pi.ts | test harness (grandchildPidFile/holdOpen hooks) | exempt — support fixtures, not test cases |

## Check 6 detail — Constitution sampling

All changed source files audited (N = 8 ≤ 10, no sampling).

| Sampled file | Principles checked | Status | Notes |
|---|---|---|---|
| parallel-utils.ts | II | compliant | mapSettled preserves siblings, no timer |
| types.ts | II | compliant | buildFailedSingleResult = finished-but-failed shape |
| subagent-executor.ts | II | compliant | mapSettled + per-task catch → partial results |
| chain-execution.ts | II | compliant | same pattern at chain parallel caller |
| subagent-runner.ts | II, III, I/IV | compliant | mapSettled + catch; detached spawn + killChildGroup; error-terminal drain reused (no new timer) |
| execution.ts | I, III, IV | compliant | detached spawn; group kill on abort/drain; error-terminal arms existing drain only; no wedge timer added |
| post-exit-stdio-guard.ts | III | compliant | killChildGroup (negative-pid group signal, direct-child fallback) |
| utils.ts | — | compliant | re-export only |

**Sampling coverage:** 8 audited of 8 changed = 100%

Timer audit (design.md) re-confirmed against the final diff: no liveness/
wedge timer exists, none added, none removed; only functional post-terminal
drains and visibility/notification timers remain (Constitution I, IV).

## Summary

- Pass count: 6/6
- Decision: green
- **Archive gate:** READY

Validator note: the repo carries pre-existing, unrelated failures on `main`
— 3 unit (schemas/TypeBox + doctor doc string) and 6 integration (intercom
grouped delivery + fork wiring). This change introduces ZERO new failures
and adds 5 passing integration tests + a mapSettled unit suite. Integration
tests must run with `PI_SUBAGENT_DEPTH`/`PI_SUBAGENT_MAX_DEPTH` unset.

## Override (if archiving despite red)

N/A — decision is green.
