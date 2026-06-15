## 1. Concurrency pool: settle-not-throw

- [ ] 1.1 Add `mapSettled<T,R>(items, limit, fn, onError)` to `parallel-utils.ts` — same bounded pool as `mapConcurrent`, but a rejecting `fn` is caught and the slot is filled by `onError(error, item, i)`; preserves input order; leave `mapConcurrent` unchanged.
  - intent: feature
  - files_allowed:
      - parallel-utils.ts
  - allow_new_files: false
- [ ] 1.2 Add a unit test that `mapSettled` settles all slots when one `fn` rejects (siblings preserved, fallback in the rejecting slot, input order) and equals `mapConcurrent` output when none reject.
  - intent: feature
  - files_allowed:
      - test/unit/parallel-utils.test.ts

## 2. Error propagation: per-task wrap + partial results

- [ ] 2.1 In `subagent-executor.ts` `runForegroundParallelTasks`, switch `mapConcurrent`→`mapSettled`, wrap the per-task `runSync(...)` in try/catch that returns a finished-but-failed `SingleResult` ({exitCode:1, error, agent, task, empty usage/messages, progress.status:"failed"}), and supply the same shape as the `onError` fallback.
  - intent: fix
  - files_allowed:
      - subagent-executor.ts
  - allow_new_files: false
- [ ] 2.2 Apply the same `mapSettled` + try/catch wrap at the chain parallel caller in `chain-execution.ts`.
  - intent: fix
  - files_allowed:
      - chain-execution.ts
  - allow_new_files: false
- [ ] 2.3 Apply the same `mapSettled` + try/catch wrap at the async parallel caller in `subagent-runner.ts` (failed parallel-result shape for that path).
  - intent: fix
  - files_allowed:
      - subagent-runner.ts
  - allow_new_files: false

## 3. Prompt settlement on error-terminal

- [ ] 3.1 In `execution.ts` `processLine`, arm `startFinalDrain()` when an assistant `message_end` has `errorMessage` set AND `!hasToolCall`, in addition to the existing `stopReason === "stop"` branch (no new timer).
  - intent: fix
  - files_allowed:
      - execution.ts
  - allow_new_files: false
- [ ] 3.2 Apply the symmetric error-terminal drain-arming in `subagent-runner.ts` `processStdoutLine`.
  - intent: fix
  - files_allowed:
      - subagent-runner.ts
  - allow_new_files: false

## 4. Cancel propagation: detached spawn + process-group kill

- [ ] 4.1 Add `killChildGroup(proc, signal)` to `post-exit-stdio-guard.ts`: signal `-proc.pid` on POSIX, fall back to `proc.kill(signal)` when group signalling throws or on platforms without process groups.
  - intent: feature
  - files_allowed:
      - post-exit-stdio-guard.ts
  - allow_new_files: false
- [ ] 4.2 In `execution.ts`, spawn the child with `detached: true`; on abort send SIGTERM then SIGKILL to the GROUP (`killChildGroup`); make forced-termination (drain) target the group. Do not `unref` the child.
  - intent: fix
  - files_allowed:
      - execution.ts
  - allow_new_files: false
- [ ] 4.3 In `subagent-runner.ts`, spawn `detached: true` and route forced-termination/interrupt through `killChildGroup` for symmetry.
  - intent: fix
  - files_allowed:
      - subagent-runner.ts
  - allow_new_files: false

## 5. Timer audit confirmation

- [ ] 5.1 Confirm (no code change) that no liveness/wedge timer exists in `src` execution paths; the design.md Timer Audit table is the record. No notification/attention/debounce timer is modified or removed.
  - intent: infra
  - files_allowed:
      - openspec/changes/propagate-task-errors-no-timeouts/design.md

## 6. Tests for recovery semantics

- [ ] 6.1 Replace `test/integration/parallel-execution.test.ts` "propagates errors" with a settle-with-partials assertion using `mapSettled` (rejecting slot → fallback; siblings preserved).
  - intent: feature
  - files_allowed:
      - test/integration/parallel-execution.test.ts
- [ ] 6.2 Add an integration test: a batch where one task exits non-zero and a sibling succeeds returns one result per task — failed task marked (exitCode≠0/error) and the sibling result preserved (cites AC `subagent-parallel-recovery.failed-task-settles-as-partial-result`).
  - intent: feature
  - files_allowed:
      - test/integration/parallel-execution.test.ts
      - test/support/**/*.ts
      - test/support/**/*.mjs
- [ ] 6.3 Add an integration test: aborting a running batch reaps the child process GROUP (including a real grandchild) and settles the slot (cites AC `subagent-parallel-recovery.abort-propagates-to-process-group`).
  - intent: feature
  - files_allowed:
      - test/integration/parallel-execution.test.ts
      - test/support/**/*.ts
      - test/support/**/*.mjs

## 7. Validate

- [ ] 7.1 Run available validators (`npm run test:unit`, `npm run test:integration`) and any typecheck/build; iterate until green; quote final output.
  - intent: infra
  - files_allowed:
      - "**/*.ts"
      - "**/*.mjs"
