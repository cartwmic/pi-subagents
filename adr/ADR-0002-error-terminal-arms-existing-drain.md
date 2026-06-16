# ADR-0002: Error-terminal messages arm the existing drain

**Status:** Accepted
**Date:** 2026-06-16
**Source change:** `openspec/changes/propagate-task-errors-no-timeouts/`
**Supersedes:** None
**Superseded by:** None

## Context

Child execution already has a bounded post-terminal drain window used after a clean terminal message. Before this change, an assistant `message_end` with `errorMessage` did not arm that drain, so a child that reported an error and then stopped producing output could wait indefinitely for `close`. Constitution I forbids wedge/liveness timeouts, but Constitution IV allows functional drain windows after terminal messages.

## Decision Drivers

- Settle error-terminal children promptly without adding a wedge timer.
- Reuse existing drain and escalation behavior instead of creating a new timer class.
- Preserve stdio draining and process cleanup before slot settlement.
- Avoid premature termination when a tool call is still pending.

## Considered Options

### Option A: Arm the existing drain on error-terminal

When an assistant `message_end` has `errorMessage` set and no pending tool call (`!hasToolCall`), call the same `startFinalDrain()` path used for clean terminal stop messages. Apply the same behavior in foreground and async runners.

**Pros:**
- Reuses existing functional post-terminal drain behavior.
- Avoids any new wedge/liveness timer.
- Preserves stdio drain and termination escalation semantics.
- The `!hasToolCall` guard mirrors the clean-stop guard.

**Cons:**
- Relies on error-terminal classification being accurate.
- Keeps settlement tied to child process close rather than resolving immediately.

### Option B: Settle synchronously on the error message

Resolve the task as failed immediately when the error-terminal message arrives.

**Pros:**
- Fastest visible settlement.
- Simple control flow.

**Cons:**
- Can resolve while the child process still lives.
- Risks orphaned descendants and lost output.
- Bypasses existing drain/termination behavior.

### Option C: Add a new short error timeout

Start a dedicated timeout when an error-terminal message appears.

**Pros:**
- Keeps error handling separate from clean terminal handling.
- Could tune error-specific timing independently.

**Cons:**
- Adds another timer and classification burden.
- Conflicts with the no-wedge-timeout constraint.
- Duplicates existing drain functionality.

## Decision Outcome

**Chosen option:** A

**Rationale:** Error-terminal messages are terminal for the turn and should use the same bounded functional drain as clean terminal messages. This settles the child through process cleanup, not by guessing that silence means wedge, and therefore stays inside Constitution I and IV.

## Consequences

**Positive:**
- Error-terminal children move toward close and failed-slot settlement.
- No new wall-clock stall watchdog, per-task deadline, or idle-poll killer is introduced.
- Clean terminal behavior remains unchanged.

**Negative:**
- Error-terminal handling depends on maintaining the `!hasToolCall` guard correctly.

**Neutral:**
- Drain and hard-kill durations remain unchanged.

## Links

- Source design discussion: `openspec/changes/propagate-task-errors-no-timeouts/design.md` (Decision D2)
- Related ADRs: ADR-0001, ADR-0003
- External references: None
