## Why

A proven production bug: when one task in a parallel `subagent` batch
wedges or errors while a sibling succeeds, the whole tool call never
returns and freezes the caller. The per-task exit Promise settles only via
`finish()` (on `close`/`error`/detach or a drain armed ONLY on a clean
`stopReason === "stop"`), so an error-terminal or wedged child never
settles its slot; `mapConcurrent`'s `Promise.all` then either waits forever
or rejects-and-discards healthy siblings. We fix this with error
propagation + caller-driven cancel — never a wedge timeout (Constitution
principle I).

## What Changes

- Per-task failures in a parallel batch settle as finished-but-FAILED
  results and the batch returns PARTIAL results (Constitution II).
- `mapConcurrent` gains a settle-not-throw sibling (`mapSettled`) so one
  failure never discards successful siblings; the three batch callers
  (`subagent-executor`, `chain-execution`, `subagent-runner`) wrap their
  per-task run in try/catch and use it.
- A child that emits an error-terminal message (`message.errorMessage`)
  arms the existing bounded drain window instead of hanging until `close`
  (error propagation, not a new timer).
- Children spawn detached (own process group) and abort escalates
  SIGTERM→SIGKILL to the process GROUP so wedged grandchildren (e.g.
  `claude-p`) die and `close` settles the slot (Constitution III).
- Timer audit: every `setTimeout`/`setInterval` in the execution paths is
  classified functional vs. wedge; no liveness/wedge timer exists to
  remove, and none is added (Constitution I, IV).
- The integration test asserting reject-on-first-error is replaced with
  settle-with-partials semantics.

No **BREAKING** public API changes: the `subagent` tool surface and result
shape are unchanged; only failure/cancel behavior is corrected.

## Capabilities

### New Capabilities
- `subagent-parallel-recovery`: error propagation and caller-driven cancel
  for parallel subagent batches — partial-result settlement, prompt
  error-terminal settlement, and process-group abort, with a strict
  no-wedge-timeout rule.

### Modified Capabilities
<!-- None: existing specs (subagent-control-notice, subagent-control-tuning,
subagent-run-status) cover visibility/notification, which this change does
not alter. -->

## Impact

- **Behavior:** parallel batches return partial results on partial failure
  instead of hanging or discarding siblings; abort reaps the child process
  tree.
- **Affected files:**
  - `parallel-utils.ts` — add `mapSettled`.
  - `subagent-executor.ts` — `runForegroundParallelTasks` wrap + `mapSettled`.
  - `chain-execution.ts` — parallel-step wrap + `mapSettled`.
  - `subagent-runner.ts` — async parallel wrap + `mapSettled`; detached
    spawn + group kill + error-terminal drain (symmetry).
  - `execution.ts` — detached spawn; error-terminal drain arming; abort and
    forced-termination kill the process GROUP.
  - `post-exit-stdio-guard.ts` — add `killChildGroup` helper.
  - `test/integration/parallel-execution.test.ts`,
    `test/unit/parallel-utils.test.ts` — updated + new coverage.
- **Dependencies:** none added.
- **Systems:** POSIX process groups (negative-PID signalling); Windows
  falls back to direct-child kill.
