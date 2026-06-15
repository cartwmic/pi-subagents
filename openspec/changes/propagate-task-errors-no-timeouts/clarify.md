# Clarify Findings

Three passes over the EARS acceptance criteria in
`specs/subagent-parallel-recovery/spec.md` (delta content only). Every
finding is resolved (status `answered`).

## Pass 1 — Ambiguity (semantic-entropy lite)

| # | AC ref | Question | Option A (keep) | Option B (change) | Status | Resolution |
|---|---|---|---|---|---|---|
| A1 | error-terminal-message-settles-promptly | "Settles promptly" could mean (X) settles synchronously the instant the error-terminal arrives, or (Y) arms the existing bounded drain window which then escalates termination. | A) keep meaning Y: arm the existing drain window (no new timer) | B) settle synchronously on the error message | answered | A (Y). Synchronous settle would resolve while the child still lives and could orphan its tree; arming the existing functional drain reuses the SIGTERM→SIGKILL escalation that yields a real `close`. Spec wording fixed to "driven toward settlement via the existing bounded drain window". |
| A2 | failed-task-settles-as-partial-result | "Finished-but-failed result" — does the failed slot carry empty usage/messages or copy partial child state? | A) keep: a minimal failed SingleResult (exitCode 1, error, empty usage/messages, progress.status "failed") | B) attempt to salvage partial messages/usage | answered | A. The throw/reject path has no trustworthy partial state; a minimal deterministic failed result is unambiguous. The non-zero-exit path (child returned a real SingleResult) naturally keeps whatever the child produced — that is a different code path and not in conflict. |
| A3 | abort-propagates-to-process-group | "Terminate the entire process group" — escalation order ambiguous (SIGKILL immediately vs SIGTERM then SIGKILL). | A) keep: SIGTERM to group, then SIGKILL to group after the existing grace | B) SIGKILL the group immediately | answered | A. Preserves the current two-stage escalation (graceful first) and only changes the TARGET from direct-child to group. Minimizes behavioral change while fixing the leak. |

## Pass 2 — Inconsistency (pairwise antecedent overlap)

| # | AC pair | Shared antecedent | Conflict on output | Option A (keep both) | Option B (resolve) | Status | Resolution |
|---|---|---|---|---|---|---|---|
| I1 | error-terminal-message-settles-promptly × no-liveness-or-wedge-timeout | A child has emitted an error-terminal and the drain window is armed | Does arming a drain timer violate "no wedge timeout"? | A) keep both: drain is FUNCTIONAL (armed only AFTER a terminal), wedge ban targets timers armed WITHOUT a terminal | B) narrow one AC | answered | A. No real conflict. Constitution IV explicitly permits post-terminal functional drains and bans only timers that infer wedging without a terminal. Both ACs hold simultaneously and consistently. |
| I2 | abort-propagates-to-process-group × no-liveness-or-wedge-timeout | An abort fires while a child runs | Does group-kill count as a timeout-based kill? | A) keep both: abort is caller-driven (signal), not time-driven | B) narrow | answered | A. The kill is triggered by the AbortSignal, never by a clock; the post-SIGTERM SIGKILL delay is escalation grace, not a wedge inference. Consistent. |
| I3 | failed-task-settles-as-partial-result × concurrency-pool-settles-not-throws | A task fails inside a batch | Which layer guarantees siblings survive? | A) keep both: try/catch wrap (per-task) AND settle-not-throw pool (defense in depth) | B) pick one layer | answered | A. Two complementary layers; the wrap converts throws to failed results, the pool guarantees survival even if a future caller forgets to wrap. No contradicting output. |

## Pass 3 — Completeness (event/state combination enumeration)

Events declared: task-exits-nonzero, task-throws/rejects, child-emits-error-terminal, child-emits-clean-terminal, abort-fires. States: child-running, child-has-descendants, platform-supports-group-signal vs not.

| # | Combination | Question | Option A (intentional silence) | Option B (add new AC) | Status | Resolution |
|---|---|---|---|---|---|---|
| C1 | abort-fires × platform-without-group-signal | What happens to abort on Windows / no negative-PID? | A) leave undefined | B) add fallback AC | answered | B applied: added scenario "Group signalling is unavailable" → fall back to direct-child signal. |
| C2 | child-emits-error-terminal × child-also-has-tool-call | Should drain arm if the error message also carries a pending tool call? | A) do not arm while a tool call is pending (turn not terminal) | B) always arm on errorMessage | answered | A. Mirrors the clean-stop guard `!hasToolCall`; an error message accompanying a tool call is not a terminal turn. Captured as a design constraint (D2), not a separate AC — it refines the existing error-terminal AC rather than adding behavior. |
| C3 | abort-fires × child-already-settled | Abort after the slot already settled (race) | A) no-op (existing `processClosed`/`settled` guards) | B) add AC | answered | A. Existing guards already make post-settlement abort a no-op; no new behavior needed, so no AC added (intentional silence, documented here). |
| C4 | task-throws × empty-batch | Throw semantics on an empty batch | A) empty batch returns empty array (no tasks to fail) | B) add AC | answered | A. Covered by existing `mapConcurrent` empty-array behavior and its unit test; intentional silence. |

## Outstanding (status != answered)

- None. All findings answered.

## Summary

- Pass 1 findings: 3; unanswered: 0; deferred: 0
- Pass 2 findings: 3; unanswered: 0; deferred: 0
- Pass 3 findings: 4; unanswered: 0; deferred: 0
- **Gate status:** READY for design
