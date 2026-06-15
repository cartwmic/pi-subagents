# Analyze Findings

**Mode:** single-model
**Generated:** 2026-06-14 by worker (Claude)

## Check 1 — Constitution compliance

| Principle | Status | Rationale | Severity |
|---|---|---|---|
| I. No liveness/wedge timeouts | compliant | Timer audit (design.md) classifies every execution-path timer; no wedge timer exists or is added. Recovery = error propagation (D1,D2,D4) + cancel (D3). | — |
| II. Failed task settles as partial result | compliant | Req "Failed Task Settles As Partial Result" + "Concurrency Pool Settles Not Throws"; D1/D4 implement it. | — |
| III. Abort propagates to the process group | compliant | Req "Abort Propagates To Process Group"; D3 detached spawn + `killChildGroup`. | — |
| IV. Functional drains permitted; visibility timers untouched | compliant | Audit keeps `finalDrainTimer`/stdio guard (functional) and `activityTimer`/notification timers (visibility) untouched; D2 reuses the drain. | — |

## Check 2 — EARS pattern check (major, human-triage)

Regex `/WHEN\s+[^.]*\b(error|fail|invalid|reject|deny|unauthor)/i` over
`specs/subagent-parallel-recovery/spec.md`:

| # | File:line | AC | True positive? | Suggested rewrite | Status |
|---|---|---|---|---|---|
| E1 | spec "One task fails, siblings succeed" | "WHEN ... one task exits non-zero while the others succeed" | no | "exits non-zero" is a nominal observed outcome of a completed task, not an unwanted system condition; the genuine error/throw path uses IF…THEN ("A task throws or rejects"). No `error/fail/invalid/...` keyword follows WHEN before the first period. | n/a |
| E2 | spec "Pool preserves order ... on rejection" | "WHEN ... one work function rejects" | no | Describes a nominal pool input event (a rejecting fn is expected input to a settle-not-throw pool), handled, not an error state. The matching keyword "reject" denotes the input, and the response is normal settlement. | n/a |
| E3 | spec error/fallback paths | "Child reports an error", "Aborted", "Group signalling is unavailable" | no | These already use IF…THEN or are nominal WHEN events (abort firing is a normal caller action). | n/a |

No true positives. Error/unwanted conditions consistently use IF…THEN.

## Check 3 — AC↔design coverage

| AC ID | Design section reference | Status | Severity |
|---|---|---|---|
| subagent-parallel-recovery.failed-task-settles-as-partial-result | D1, D4 | covered | — |
| subagent-parallel-recovery.concurrency-pool-settles-not-throws | D1 | covered | — |
| subagent-parallel-recovery.error-terminal-message-settles-promptly | D2 | covered | — |
| subagent-parallel-recovery.abort-propagates-to-process-group | D3 | covered | — |
| subagent-parallel-recovery.no-liveness-or-wedge-timeout | Timer Audit; Goals/Non-Goals | covered | — |

## Check 4 — design↔ADR promotion candidates (Scale ≥ L)

Scale = M, so ADR promotion is not mandatory. Recorded for completeness:

| Decision | 4-point score | ADR-candidate? | Rationale or "ADR not warranted because…" |
|---|---|---|---|
| D1 mapSettled | 4 | yes | Lasting concurrency-utility contract. |
| D2 error-terminal drain | 3 | yes | Settlement model decision. |
| D3 detached + group kill | 4 | yes | Cross-platform process-lifecycle decision. |
| D4 try/catch wrap | 1 | no | ADR not warranted: local defensive pattern, no lasting cross-cutting consequence. |
| D5 async-runner symmetry | 1 | no | ADR not warranted: applies D1–D3 to a second site, no new decision. |

At Scale = M these are flagged but not auto-promoted (skill offers at
archive if Scale raised).

## Check 5 — Duplicate detection

| # | Locations | Restated constraint | Action |
|---|---|---|---|
| Dup1 | Req "Failed Task..." (try/catch) + Req "Concurrency Pool..." (settle) | Both ensure sibling survival on failure | differentiate — intentional defense-in-depth (clarify I3); kept as two distinct layers (per-task wrap vs pool guarantee). Not a true duplicate. |

## Check 6 — Implementation language in specs

| # | AC ID | Tech mentioned | Rewrite suggestion |
|---|---|---|---|
| Imp1 | abort-propagates-to-process-group | "process group", "SIGTERM", "SIGKILL", "detached" | Retained intentionally: these are the behavioral contract (which OS facility must be exercised) and are domain vocabulary in domain.md, not gratuitous solution-coupling. The signal escalation IS the observable behavior under test. |
| Imp2 | error-terminal-message-settles-promptly | "errorMessage", "close event", "drain window" | Retained: names the observable child protocol (message field) and parent obligation; behavioral, justified, and grounded in domain.md entities. |

Findings are acknowledged, not violations: the named mechanisms are the
behavior being specified and are defined as domain entities.

## Check 7 — Unresolved clarify findings

| # | clarify.md ref | Status | Risk |
|---|---|---|---|
| — | A1,A2,A3,I1,I2,I3,C1,C2,C3,C4 | answered | none — all resolved |

## Outstanding risks

- None deferred from clarify. Carry design risks R1–R5 into apply/verify
  (process-group behavior validated by the grandchild-reaping integration
  test).

## Summary

- Blockers: 0
- Major findings: 0
- Minor findings: 0 (Check 5/6 entries acknowledged, not violations)
- **Gate status:** READY for tasks
