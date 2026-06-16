## Context

The `subagent` tool runs parallel batches via a concurrency pool. The
foreground/sync path is `subagent-executor.ts` →
`runForegroundParallelTasks` → `mapConcurrent` → `runSync`
(`execution.ts`). The chain path is `chain-execution.ts` → `mapConcurrent`
→ `runSync`. The async/background path is `subagent-runner.ts` →
`mapConcurrent` → `runSingleStep` → `runPiStreaming` (its own spawn).

Per-task settlement (`execution.ts`) is gated by a single `finish()` that
resolves the exit Promise. `finish()` is only reached on `proc.on("close")`,
`proc.on("error")`, intercom detach, or a final-drain timer that ARMS ONLY
when a clean terminal arrives (`stopReason === "stop" && !hasToolCall`,
execution.ts ~line 404). Consequences:

1. A child that emits an **error-terminal** (`message.errorMessage` set) but
   no clean stop never arms the drain — it settles only if `close` happens.
2. A **wedged** child emits no `close` → slot never settles →
   `mapConcurrent`'s `Promise.all` never resolves → the tool hangs even
   though a sibling finished.
3. `mapConcurrent`'s `Promise.all` **rejects on first rejection** and
   discards successful siblings (test `propagates errors` enshrines this).
4. `spawn(...)` is **not detached** and aborts call `proc.kill(...)` on the
   direct child PID only — a grandchild (`claude-p`) survives, holds the
   pipe, and suppresses `close`, so cancel does not settle either.

This design respects Constitution I (no wedge timeouts), II (failed task =
partial result), III (abort → process group), IV (functional drains and
visibility timers preserved), and domain invariants 1–7.

## Goals / Non-Goals

**Goals:**
- A failed/throwing task settles as a finished-but-failed result; siblings
  survive; batch returns partial results.
- An error-terminal child arms the existing bounded drain instead of
  hanging until `close`.
- Abort SIGTERM→SIGKILLs the child process GROUP, reaping grandchildren.
- Audit and classify every execution-path timer; confirm no wedge timer
  exists or is added.

**Non-Goals:**
- No stall watchdog, per-task deadline, or idle-poll killer (Constitution I).
- No change to model fallback, control-notice/attention tuning, worktree
  setup, or the `subagent` tool's public surface/result shape.
- No new third-party dependency (e.g. a tree-kill library).

## Decisions

### D1: Settle-not-throw via a new `mapSettled` variant

**Choice:** Add `mapSettled<T,R>(items, limit, fn, onError)` to
`parallel-utils.ts` that runs the same bounded pool but catches a rejecting
`fn` and stores `onError(error, item, i)` in that slot. Switch the three
batch callers to `mapSettled`. Leave `mapConcurrent` intact for any
fail-fast use.

**Alternatives considered:**
- **Change `mapConcurrent` in place to swallow rejections**: smaller diff
  but silently changes semantics for any future caller expecting throw;
  loses the explicit fallback mapping.
- **`Promise.allSettled` rewrite**: loses the bounded-concurrency pool and
  in-order results that the existing pool guarantees.

**Rationale:** Explicit, backward-compatible, gives each caller control of
the fallback result shape (a failed SingleResult vs a failed parallel
result). Pairs with per-caller try/catch (D4) for defense in depth.

**4-point test:** multiple approaches Y; lasting Y; reasonable disagreement
Y; constrains future Y → ADR candidate **Yes**.

### D2: Error-terminal arms the existing drain (no new timer)

**Choice:** In `execution.ts` `processLine`, arm `startFinalDrain()` when an
assistant `message_end` has `errorMessage` set AND no pending tool call
(`!hasToolCall`), in addition to the existing `stopReason === "stop"`
branch. Apply the symmetric change in `subagent-runner.ts`.

**Alternatives considered:**
- **Settle synchronously on the error message** (clarify A1 option B):
  resolves while the child still lives → can orphan the tree; loses stdio
  drain.
- **A new short error-timeout timer**: forbidden by Constitution I and
  unnecessary — the drain already exists.

**Rationale:** Reuses the functional, bounded post-terminal drain
(SIGTERM→SIGKILL escalation already wired) so `close` fires and the slot
settles as failed. The `!hasToolCall` guard mirrors the clean-stop guard so
an error message accompanying a tool call (turn not terminal) does not arm
prematurely (clarify C2).

**4-point test:** multiple approaches Y; lasting Y; disagreement Y;
constrains future N → ADR candidate **Yes** (≥3/4).

### D3: Detached spawn + process-group termination

**Choice:** Spawn children with `detached: true` (own process group). Add
`killChildGroup(proc, signal)` to `post-exit-stdio-guard.ts` that signals
`-proc.pid` on POSIX (falling back to `proc.kill` when group signalling is
unavailable or on Windows). Use group termination on the abort path and the
forced-termination (drain) path so grandchildren are reaped. Do NOT
`unref()` the child (the parent must still await it).

**Alternatives considered:**
- **`proc.kill()` on the direct child only** (status quo): leaks
  grandchildren, suppresses `close` — the bug.
- **A `tree-kill` dependency**: adds a dependency and platform shelling-out
  for what `detached` + negative-PID does natively.

**Rationale:** Native, dependency-free, satisfies Constitution III and
domain invariants 4–5. Windows degrades gracefully to direct-child kill
(spec scenario "Group signalling is unavailable").

**4-point test:** multiple approaches Y; lasting Y; disagreement Y;
constrains future Y → ADR candidate **Yes**.

### D4: Per-caller try/catch wrap (defense in depth)

**Choice:** At each of the three batch callers, wrap the per-task
`runSync`/`runSingleStep` in try/catch that returns a finished-but-failed
result, in addition to passing `onError` to `mapSettled`.

**Alternatives considered:**
- **Rely on `mapSettled` alone**: works, but a caller-local catch keeps the
  failed-result shape co-located with the caller's result type and protects
  even if a future refactor reintroduces `mapConcurrent`.

**Rationale:** Two cheap, independent layers guaranteeing sibling survival
(clarify I3). Low risk, high resilience.

**4-point test:** multiple approaches Y; lasting N; disagreement N;
constrains future N → ADR candidate **No** (1/4); note in analyze.

### D5: Symmetric fix in the async runner

**Choice:** Apply D1–D3 to `subagent-runner.ts` (async/background batches)
as well as the foreground path, since it duplicates the spawn + drain +
parallel-map structure.

**Alternatives considered:**
- **Foreground-only fix**: leaves the identical hang latent in async
  batches.

**Rationale:** Same root cause, same recovery model; symmetry prevents a
regression resurfacing via the async path.

**4-point test:** multiple approaches N; lasting Y; disagreement N;
constrains future N → ADR candidate **No** (1/4).

## Timer Audit (Constitution I, IV)

Every `setTimeout`/`setInterval` reachable from the execution paths,
classified. **No wedge/liveness timer exists; none is added; none removed.**

| Location | Timer | Classification | Action |
|---|---|---|---|
| execution.ts ~230 | `finalDrainTimer` (5000ms) | Functional post-terminal drain (armed only AFTER a terminal) | Keep; also arm on error-terminal (D2) |
| execution.ts ~236 | `finalHardKillTimer` (3000ms) | Functional escalation after drain | Keep; target group (D3) |
| execution.ts ~423 | `activityTimer` (1000ms interval) | Visibility (control-notice activity state) | Keep, untouched |
| execution.ts ~490 | abort SIGKILL (3000ms) | Functional escalation after caller abort | Keep; target group (D3) |
| execution.ts ~510 | interrupt SIGTERM (1000ms) | Functional escalation after SIGINT | Keep |
| post-exit-stdio-guard.ts 60/78 | idle/hard stdio timers | Functional stdio drain (armed only AFTER `exit`) | Keep |
| subagent-runner.ts ~309 | interrupt SIGTERM (1000ms) | Functional escalation | Keep |
| subagent-runner.ts ~325/331 | drain/hard-kill timers | Functional post-terminal drain/escalation | Keep; arm on error-terminal + group (D2,D3) |
| subagent-runner.ts ~966 | `activityTimer` (1000ms) | Visibility | Keep, untouched |
| async-job-tracker.ts 40/128 | cleanup / status poller | Lifecycle/visibility (not a child killer) | Untouched |
| result-intercom.ts ~167 | intercom response wait | Functional coordination wait (not a child wedge-kill) | Untouched |
| file-coalescer.ts; chain-clarify.ts ~344 | debounce | Functional scheduling | Untouched |
| index.ts 423/912/923; subagents-status.ts 197; render.ts; result-watcher.ts 120 | coalesce/sweep/refresh/animation/restart | Visibility/notification/lifecycle | Untouched |

Closest-to-wedge candidate is `finalDrainTimer`: it is **functional**, not a
wedge guesser, because it arms ONLY after a terminal message — never on a
clock while the child is producing or silent. It stays.

## Risks / Trade-offs

| # | Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|---|
| R1 | `detached: true` changes signal delivery / orphaning on some OS | Low | Medium | POSIX-guarded negative-PID with `proc.kill` fallback; do not `unref`; integration test reaps a real grandchild |
| R2 | Group SIGKILL kills more than intended | Low | Medium | Child is its own group leader (detached); only its descendants are in the group, never the parent |
| R3 | Error-terminal drain arms when a tool call is still pending | Low | Low | `!hasToolCall` guard mirrors the clean-stop guard (clarify C2) |
| R4 | Async-runner symmetry introduces a subtle divergence | Low | Low | Mirror the exact execution.ts changes; reuse the shared `killChildGroup` helper |
| R5 | Windows lacks negative-PID groups | Medium | Low | Fallback to direct-child kill (spec "Group signalling is unavailable") |

## Migration Plan

No data or API migration. Behavioral-only. Rollback = revert the code
commit; artifacts are inert. Compatible with existing callers (result shape
unchanged).

## Open Questions

- None blocking. (Windows group-kill is handled by documented fallback;
  primary target is POSIX where the production bug reproduces.)
