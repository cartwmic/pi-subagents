# ADR-0001: Settle-not-throw via mapSettled

**Status:** Accepted
**Date:** 2026-06-16
**Source change:** `openspec/changes/propagate-task-errors-no-timeouts/`
**Supersedes:** None
**Superseded by:** None

## Context

The `subagent` tool runs parallel batches through a bounded concurrency pool. Before this change, `mapConcurrent` used fail-fast `Promise.all` behavior: one rejecting task could reject the whole batch, discard successful sibling results, and prevent the tool from returning a complete partial-result set. Constitution II requires failed tasks to become partial results, and domain invariants 1 and 7 require every slot to settle while preserving sibling results.

## Decision Drivers

- Preserve bounded concurrency and input-order result guarantees.
- Return one result per task even when a task throws or rejects.
- Keep fail-fast semantics available for callers that need them.
- Let each caller choose the failed-result shape for its own result type.
- Avoid broad public-surface or result-shape changes.

## Considered Options

### Option A: Add `mapSettled`

Add `mapSettled<T,R>(items, limit, fn, onError)` beside `mapConcurrent`. It uses the same bounded pool, catches a rejecting `fn`, and stores `onError(error, item, i)` in that slot. Batch callers switch to `mapSettled` and provide fallback results shaped for their path.

**Pros:**
- Preserves bounded concurrency and input order.
- Makes settle-not-throw behavior explicit at call sites.
- Keeps `mapConcurrent` available for fail-fast use.
- Co-locates fallback result shape with caller semantics.

**Cons:**
- Adds a second pool helper with overlapping implementation behavior.
- Requires callers to choose correct fallback shapes.

### Option B: Change `mapConcurrent` in place

Modify `mapConcurrent` to catch rejections and return fallback values.

**Pros:**
- Smaller API surface.
- Fewer call-site changes.

**Cons:**
- Silently changes semantics for any current or future fail-fast caller.
- Obscures where fallback result shapes come from.
- Makes rejection handling less explicit.

### Option C: Rewrite with `Promise.allSettled`

Use `Promise.allSettled` to collect all results and failures.

**Pros:**
- Uses a standard language primitive.
- Naturally returns all settlements.

**Cons:**
- Loses the existing bounded-concurrency pool behavior.
- Requires extra machinery to preserve current scheduling and ordering guarantees.

## Decision Outcome

**Chosen option:** A

**Rationale:** `mapSettled` is explicit and backward-compatible. It preserves the bounded pool and ordered results while giving each caller control over the fallback failed-result shape. This satisfies partial-result recovery without changing `mapConcurrent` semantics.

## Consequences

**Positive:**
- Parallel batches return successful siblings plus finished-but-failed results for failed slots.
- Future readers can distinguish fail-fast and settle-not-throw pool use.
- Callers can preserve their own result schemas without centralizing schema knowledge in the pool helper.

**Negative:**
- Pool behavior now has two helpers to maintain.
- A caller can still choose the wrong helper in future code unless tests cover the path.

**Neutral:**
- Public `subagent` result shape is unchanged.

## Links

- Source design discussion: `openspec/changes/propagate-task-errors-no-timeouts/design.md` (Decision D1)
- Related ADRs: ADR-0002, ADR-0003
- External references: None
