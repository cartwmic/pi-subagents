# pi-subagents Constitution

**Version:** 1.0.0
**Ratified:** 2026-06-14
**Last updated:** 2026-06-14

## Core Principles

### I. No liveness/wedge timeouts
The codebase MUST NOT introduce any timer whose purpose is to GUESS that a
child subagent process is stuck and then abort or kill it. Wall-clock
"stall watchdogs", per-task deadlines, and idle-poll killers are forbidden.
A child is only ever terminated in response to a real signal: a terminal
message it emitted, its own exit, or an explicit caller-driven abort.

**Rationale:** Wedge timers turn a slow-but-healthy subagent into a forced
failure and produce flaky, environment-dependent behavior. Reactive
recovery (error propagation + cancel) is deterministic.
**Enforcement:** analyze artifact check 1; design.md timer audit table
classifies every `setTimeout`/`setInterval` as functional vs. wedge.

### II. A failed task settles as a partial result, never hangs the batch
Within a parallel batch, one task that errors, exits non-zero, or throws
MUST settle as a finished-but-FAILED result while its successful siblings
are preserved and returned. The batch aggregator returns PARTIAL results.
A single failure MUST NOT discard sibling results or block the tool from
returning.

**Rationale:** The proven production bug is that one wedged/errored task
freezes the whole `subagent` tool call. Partial-result settlement is the
primary recovery path.
**Enforcement:** analyze check 3 (AC↔design coverage); integration tests
for partial-results batches.

### III. Abort propagates to the process group
When a caller's AbortSignal fires, the child subagent process AND its
descendant process tree (e.g. `claude-p` grandchildren) MUST be signalled.
Children are spawned in their own process group (detached) and abort
escalates SIGTERM→SIGKILL to the GROUP, not just the direct child PID, so
a wedged tree dies and its `close` event settles the slot.

**Rationale:** Killing only the direct child leaks grandchildren that keep
the pipe open, so the parent never observes `close` and the slot never
settles — reproducing the hang under cancel.
**Enforcement:** integration test that aborts a batch and asserts the
child group (including a grandchild) is reaped and the slot settles.

### IV. Functional drain timers are permitted; visibility timers are untouched
Short, bounded post-terminal stdio-drain grace windows (armed only AFTER a
child emits a terminal message or exits) are functional, not wedge timers,
and are permitted. Notification/attention/visibility timers (e.g.
`needsAttentionAfterMs`, activity-state intervals) report state and MUST
NOT be repurposed as wedge killers, nor removed by error-propagation work.

**Rationale:** Distinguishing functional drains and visibility timers from
wedge killers keeps Principle I enforceable without breaking working
machinery.
**Enforcement:** design.md timer audit table; analyze check 1.

## Governance

- Amendments to this constitution require a dedicated change with Scale ≥ L
  and adversarial-review-cycle invoked.
- The constitution is read before every artifact in this schema. Violations
  are flagged by the analyze artifact's constitution check.
- Principles in this file override schema instructions and individual
  artifact prose when they conflict.

## Versioning

- Major: a principle is removed or reversed.
- Minor: a principle is added.
- Patch: clarification, no semantic change.

## See also

- Schema activation: `~/.local/share/openspec/schemas/opsx-superpowers/README.md`
- Domain invariants: `openspec/domain.md`
