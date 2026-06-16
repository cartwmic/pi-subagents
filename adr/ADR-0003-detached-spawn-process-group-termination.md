# ADR-0003: Detached spawn and process-group termination

**Status:** Accepted
**Date:** 2026-06-16
**Source change:** `openspec/changes/propagate-task-errors-no-timeouts/`
**Supersedes:** None
**Superseded by:** None

## Context

Abort and forced-termination paths previously signalled only the direct child process. If that child spawned descendants, the descendant process could survive, keep pipes open, and prevent `close` from firing. Constitution III requires abort to propagate to the child process group, and domain invariants 4 and 5 require descendant reaping so task slots settle.

## Decision Drivers

- Ensure abort and forced termination reap children and grandchildren.
- Avoid adding a third-party tree-kill dependency.
- Preserve parent ownership of child lifetime; do not `unref()`.
- Degrade gracefully on platforms without negative-PID process-group signalling.
- Keep termination behavior shared across foreground and async paths.

## Considered Options

### Option A: Spawn detached and signal the process group

Spawn child processes with `detached: true` so each child becomes its own process-group leader. Add `killChildGroup(proc, signal)` that signals `-proc.pid` on POSIX and falls back to direct-child `proc.kill(signal)` when group signalling is unavailable or unsupported. Use the helper for abort and forced termination. Do not call `unref()`.

**Pros:**
- Native, dependency-free process-group termination on POSIX.
- Reaps descendants that would otherwise keep pipes open.
- Keeps the parent awaiting child close.
- Provides direct-child fallback for unsupported platforms.

**Cons:**
- `detached: true` changes process-group behavior and signal boundaries.
- Windows fallback is weaker than POSIX process-group signalling.

### Option B: Kill only the direct child

Keep using `proc.kill()` against the direct child PID.

**Pros:**
- Smallest implementation.
- Existing platform behavior remains unchanged.

**Cons:**
- Does not kill grandchildren.
- Leaves the original hang path intact when descendants hold stdio open.
- Fails Constitution III.

### Option C: Add a `tree-kill` dependency

Use a dependency to discover and terminate process trees.

**Pros:**
- Abstracts platform differences.
- Could improve Windows descendant handling.

**Cons:**
- Adds dependency and platform shelling-out.
- More moving parts than native POSIX process groups.
- Unneeded for the primary reproduction target.

## Decision Outcome

**Chosen option:** A

**Rationale:** Detached spawn plus negative-PID signalling is the minimal dependency-free way to make the child its own process-group leader and terminate descendants reliably on POSIX. The direct-child fallback ensures termination still progresses where group signalling is unavailable.

## Consequences

**Positive:**
- Caller abort can terminate child and descendant processes.
- Post-terminal forced termination no longer leaves grandchildren holding pipes open on POSIX.
- Shared helper centralizes group-kill fallback behavior.

**Negative:**
- Platform behavior differs: POSIX gets group kill; unsupported platforms fall back to direct-child kill.
- Future spawn changes must preserve process-group isolation.

**Neutral:**
- Children remain referenced; parent still waits for close.

## Links

- Source design discussion: `openspec/changes/propagate-task-errors-no-timeouts/design.md` (Decision D3)
- Related ADRs: ADR-0001, ADR-0002
- External references: None
