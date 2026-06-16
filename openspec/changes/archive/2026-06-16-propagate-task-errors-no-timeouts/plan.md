# Execution Plan

## Plan step 1: Settle-not-throw pool

- **Covers:** T1.1, T1.2
- **Pre-conditions:** `parallel-utils.ts` and `test/unit/parallel-utils.test.ts` present.
- **Action (5-step micro-tasks):**
  1. Write failing unit test for `mapSettled` (cites AC `subagent-parallel-recovery.concurrency-pool-settles-not-throws`).
  2. Run `npm run test:unit` → expect FAIL (mapSettled undefined).
  3. Implement `mapSettled` (catch reject → `onError` fallback, in-order).
  4. Run `npm run test:unit` → expect PASS.
  5. Commit (`feat(parallel): add mapSettled settle-not-throw pool`).
- **Verification:** `npm run test:unit`.
- **Rollback:** revert `parallel-utils.ts` + test hunk.

## Plan step 2: Per-task wrap + partial results at the three callers

- **Covers:** T2.1, T2.2, T2.3
- **Pre-conditions:** Step 1 merged; `SingleResult` shape known from `types.ts`.
- **Action:**
  1. Add failing integration test: one task non-zero exit + one success → partial results (cites AC `subagent-parallel-recovery.failed-task-settles-as-partial-result`).
  2. Run `npm run test:integration` → expect FAIL (hang/discard).
  3. Switch each caller to `mapSettled`; wrap `runSync`/`runSingleStep` in try/catch returning a failed result.
  4. Run `npm run test:integration` → expect PASS.
  5. Commit (`fix(parallel): settle failed tasks as partial results`).
- **Verification:** `npm run test:integration`.
- **Rollback:** revert the three caller hunks.

## Plan step 3: Error-terminal drain arming

- **Covers:** T3.1, T3.2
- **Pre-conditions:** Step 2 merged.
- **Action:**
  1. Identify the `message_end` handler in `execution.ts` / `subagent-runner.ts`.
  2. Add `errorMessage && !hasToolCall` to the `startFinalDrain()` arming condition (cites AC `subagent-parallel-recovery.error-terminal-message-settles-promptly`).
  3. Run unit + integration suites → expect PASS.
  4. Commit (`fix(execution): settle on error-terminal via existing drain`).
- **Verification:** `npm run test:unit && npm run test:integration`.
- **Rollback:** revert the two arming-condition hunks.

## Plan step 4: Detached spawn + process-group kill

- **Covers:** T4.1, T4.2, T4.3
- **Pre-conditions:** Step 3 merged.
- **Action:**
  1. Add failing integration test: abort a running batch reaps a real grandchild and settles (cites AC `subagent-parallel-recovery.abort-propagates-to-process-group`).
  2. Run `npm run test:integration` → expect FAIL (grandchild survives).
  3. Add `killChildGroup`; spawn `detached: true`; route abort + forced-termination through the group kill in both runners.
  4. Run `npm run test:integration` → expect PASS.
  5. Commit (`fix(execution): abort kills child process group`).
- **Verification:** `npm run test:integration`.
- **Rollback:** revert spawn + kill hunks + helper.

## Plan step 5: Timer audit + final validation

- **Covers:** T5.1, T6.1, T7.1
- **Pre-conditions:** Steps 1–4 merged.
- **Action:**
  1. Replace the "propagates errors" test with settle-with-partials (cites AC `...concurrency-pool-settles-not-throws`).
  2. Confirm design.md Timer Audit matches the code (no wedge timer added/removed).
  3. Run full suites; iterate to green.
  4. Commit (`test(parallel): assert settle-with-partials; not reject-on-first`).
- **Verification:** `npm run test:unit && npm run test:integration`.
- **Rollback:** revert test hunk.

## Completion Verification

- `npm run test:unit && npm run test:integration` → all suites pass; the
  five `subagent-parallel-recovery.*` ACs are each cited by at least one
  test; design.md Timer Audit shows zero wedge timers.

## Manual Adjustments

- Execution Mode = tdd-preferred: tests precede each behavioral hunk where
  practical (settle-not-throw, partial results, group-kill).
- No typecheck/build script exists in package.json; validation is the two
  test scripts (`tsc` is exercised implicitly via `--experimental-strip-types`).
