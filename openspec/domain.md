# pi-subagents Domain

**Version:** 1.0.0
**Last updated:** 2026-06-14

## Entities

- **Subagent tool** — the `subagent` extension tool. Accepts single, chain,
  or parallel-batch invocations and returns aggregated output to the caller.
- **Task** — one unit of work in a batch: an `{agent, task}` pair executed by
  a child `pi` process.
- **Batch** — a set of tasks run concurrently under a concurrency limit by
  `mapConcurrent`/`mapSettled`.
- **Child process** — the spawned `pi` process that runs one task. It may
  spawn descendant processes (grandchildren, e.g. a `claude-p` model CLI).
- **Slot** — a worker position in the concurrency pool; a slot "settles" when
  its task's result Promise resolves.
- **SingleResult** — the per-task result object (`exitCode`, `error`,
  `messages`, `usage`, `progress`, etc.) carried back to the aggregator.
- **Terminal message** — an assistant `message_end` event that ends a turn:
  either a clean stop (`stopReason === "stop"`) or an error-terminal
  (`message.errorMessage` is set).
- **Drain window** — a short, bounded grace period armed AFTER a terminal
  message or exit to flush stdio before forcing termination.

## Invariants

1. A batch result Promise settles iff every slot settles; a slot settles iff
   its task's result Promise resolves.
2. A child's result Promise resolves only on `close`, `error`, explicit
   detach, or settlement triggered by a terminal message it emitted.
3. A child that emits a terminal message but never exits will not produce a
   `close` event on its own; the parent must drive termination to observe it.
4. Killing only the direct child PID does not reap descendant processes; a
   surviving grandchild can hold the stdout pipe open and suppress `close`.
5. A detached child becomes its own process-group leader, so a negative-PID
   group signal reaches the child and all its descendants.
6. Exit code 0 with no error means success; any non-zero exit, a set
   `error`, or a thrown exception means the task FAILED.
7. A failed task never removes or corrupts a sibling task's SingleResult.

## Units and conventions

- **Time**: epoch millis (`Date.now()`) in memory; drain/escalation windows
  are fixed millisecond constants (e.g. 5000ms drain, 3000ms hard-kill).
- **Exit codes**: 0 = success; 1 = generic failure; -1 = skipped; -2 =
  detached for intercom coordination.
- **Signals**: SIGINT (interrupt/soft), SIGTERM (graceful terminate),
  SIGKILL (forced). Group signals use negative PID on POSIX.
- **Naming**: camelCase in TS; kebab-case for capability/spec folder names.

## Out-of-scope domains

- Model selection / fallback — handled by `model-fallback.ts`; this change
  does not alter model choice.
- Control-notice / attention notification tuning — visibility machinery in
  `subagent-control.ts` / `liveness.ts`; this change does not change when
  notices fire, only that wedge-killing is never added.
- Worktree setup and diffing — orthogonal to error propagation and cancel.

## See also

- Constitution: `openspec/constitution.md`
- Schema docs: `~/.local/share/openspec/schemas/opsx-superpowers/README.md`
