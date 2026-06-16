# Capability: subagent-parallel-recovery

## ADDED Requirements

### Requirement: Failed Task Settles As Partial Result

A parallel batch SHALL always return one result per task, marking failed
tasks as finished-but-failed while preserving successful siblings, so the
`subagent` tool returns partial results instead of hanging or discarding
results. (Domain invariants 6, 7.)

#### Scenario: One task fails, siblings succeed
- **WHEN** a batch of tasks runs concurrently and one task exits non-zero
  while the others succeed
- **THEN** the batch returns one result per task, the failed task's result
  has a non-zero `exitCode` and a populated `error`, and every successful
  sibling result is present and unchanged

#### Scenario: A task throws or rejects
- **IF** the per-task run throws or its Promise rejects
- **THEN** the batch SHALL convert it into a finished-but-failed result
  (`exitCode` 1, `error` set, `progress.status` "failed") for that slot and
  SHALL continue returning all sibling results

#### Scenario: Aggregated output marks failures
- **WHEN** a batch containing at least one failed task completes
- **THEN** the aggregated output SHALL render the failed task as `FAILED`
  with its exit code while rendering successful siblings normally

### Requirement: Concurrency Pool Settles Not Throws

THE concurrency pool used for parallel batches SHALL settle every slot
even when one task's work function rejects, never aborting the whole pool
on the first rejection. (Domain invariants 1, 7.)

#### Scenario: Pool preserves order and siblings on rejection
- **WHEN** a settle-not-throw batch runs and one work function rejects
- **THEN** the returned array SHALL have one entry per input in input
  order, with the rejecting slot replaced by a caller-supplied fallback
  result and all other slots holding their resolved values

#### Scenario: All-success batch is unaffected
- **WHEN** a settle-not-throw batch runs and no work function rejects
- **THEN** the returned array SHALL equal the values returned by the work
  functions, in input order, identical to the non-settling pool

### Requirement: Error-Terminal Message Settles Promptly

THE parent SHALL drive a child's exit Promise toward settlement via the existing bounded drain window when the child emits an error-terminal message, rather than waiting indefinitely for a `close` event. (Domain invariants 2, 3.)

#### Scenario: Child reports an error then stops producing output
- **WHEN** a child emits an assistant message whose `errorMessage` is set
  and then produces no further output and does not exit on its own
- **THEN** the parent SHALL arm the bounded post-terminal drain window
  (the same window armed on a clean stop) and, after the drain grace,
  escalate termination so the child's `close` settles the slot as failed

#### Scenario: Clean terminal still settles
- **WHEN** a child emits a clean terminal message (`stopReason` "stop")
- **THEN** the existing drain-and-settle behavior SHALL be unchanged

### Requirement: Abort Propagates To Process Group

THE parent SHALL terminate a running child's entire process group when the caller's abort signal fires, so the child and its descendant processes die and the resulting `close` settles the slot. (Constitution III; domain invariants 4, 5.)

#### Scenario: Abort kills child and grandchildren
- **WHEN** a running child has spawned descendant processes and the
  caller's abort signal fires
- **THEN** the parent SHALL signal the child's process group (not only the
  direct child PID), escalating SIGTERM then SIGKILL, so the child and its
  descendants terminate and the slot settles

#### Scenario: Child is spawned in its own process group
- **THEN** THE parent SHALL spawn each child detached so the child is its
  own process-group leader, enabling group-targeted termination

#### Scenario: Group signalling is unavailable
- **IF** the platform does not support negative-PID group signalling
- **THEN** the parent SHALL fall back to signalling the direct child
  process so termination still progresses

### Requirement: No Liveness Or Wedge Timeout

THE recovery model SHALL NOT include any timer that infers a child is
wedged and aborts or kills it; recovery SHALL rely only on error
propagation and caller-driven cancel. (Constitution I, IV.)

#### Scenario: No stall watchdog is introduced
- **THEN** THE codebase SHALL contain no wall-clock stall watchdog,
  per-task deadline, or idle-poll killer; only functional post-terminal
  drain windows and visibility/notification timers SHALL remain

#### Scenario: Visibility timers are preserved
- **WHILE** a child runs without emitting a terminal message
- **THEN** THE parent SHALL NOT terminate the child on any time basis, and
  existing notification/attention timers SHALL continue to report state
  without killing the child

---

## Acceptance criterion quality checklist

| AC ID | Testable | Solution-free | Unambiguous | Consistent | Complete |
|---|---|---|---|---|---|
| subagent-parallel-recovery.failed-task-settles-as-partial-result | [x] | [x] | [x] | [x] | [x] |
| subagent-parallel-recovery.concurrency-pool-settles-not-throws | [x] | [x] | [x] | [x] | [x] |
| subagent-parallel-recovery.error-terminal-message-settles-promptly | [x] | [x] | [x] | [x] | [x] |
| subagent-parallel-recovery.abort-propagates-to-process-group | [x] | [x] | [x] | [x] | [x] |
| subagent-parallel-recovery.no-liveness-or-wedge-timeout | [x] | [x] | [x] | [x] | [x] |
