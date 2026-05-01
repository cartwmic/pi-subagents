/**
 * Unit tests for the control-notice receiver-side liveness gate and
 * delivery-time deferral (Batch 4: tasks 5.1–5.6).
 *
 * Tests are driven through the two exported helpers:
 *   - processControlEvent  (logic extracted from the controlEventHandler closure)
 *   - flushPendingNotices  (flush function)
 *
 * index.ts transitively imports render.ts which imports
 * @mariozechner/pi-coding-agent (a value import that isn't installed in the
 * unit-test environment).  We intercept render.ts at module-load time via
 * node:module.register() + a data-URL loader BEFORE the dynamic import, same
 * pattern as async-job-tracker-poll-order.test.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { register } from "node:module";
import type { SubagentState } from "../../types.ts";
import { buildControlEvent } from "../../subagent-control.ts";

// ---------------------------------------------------------------------------
// Stub render.ts and handle .js→.ts rewrites (some modules use .js extensions).
// Must be registered BEFORE the dynamic import of index.ts below.
// ---------------------------------------------------------------------------
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const stubLoader = `
import * as _fs from 'node:fs';
import * as _path from 'node:path';
import { fileURLToPath as _fileURLToPath } from 'node:url';

const renderStub = 'data:text/javascript,export function renderWidget(){}; export function renderSubagentResult(){}; export function stopResultAnimations(){}; export function stopWidgetAnimation(){}; export function syncResultAnimation(){}';

export async function resolve(specifier, context, nextResolve) {
  // Stub render.ts so @mariozechner/pi-coding-agent is not resolved as a value.
  if (specifier.endsWith('render.ts') || specifier.endsWith('render.js')) {
    return { shortCircuit: true, url: renderStub };
  }
  // Rewrite .js local imports to .ts when the .js file does not exist.
  if (specifier.startsWith('.') && specifier.endsWith('.js')) {
    const parentDir = context.parentURL
      ? _path.dirname(_fileURLToPath(context.parentURL))
      : process.cwd();
    const jsPath = _path.resolve(parentDir, specifier);
    const tsPath = jsPath.replace(/\.js$/, '.ts');
    if (!_fs.existsSync(jsPath) && _fs.existsSync(tsPath)) {
      return nextResolve(specifier.replace(/\.js$/, '.ts'), context);
    }
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(stubLoader)}`, import.meta.url);

// Dynamic import so the stub loader above is already in effect.
const {
	processControlEvent,
	flushPendingNotices,
	visibleControlNoticesStoreKey,
} = (await import("../../index.ts")) as {
	processControlEvent: (
		payload: unknown,
		globalStore: Record<string, unknown>,
		state: SubagentState,
		visibleControlNotices: Set<string>,
	) => void;
	flushPendingNotices: (
		pi: { sendMessage(msg: unknown, opts: unknown): void },
		globalStore: Record<string, unknown>,
		state: SubagentState,
	) => void;
	visibleControlNoticesStoreKey: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const __piSubagentPendingNotices = "__piSubagentPendingNotices";
const __piSubagentDroppedStaleNotices = "__piSubagentDroppedStaleNotices";
const __piSubagentDedupedNotices = "__piSubagentDedupedNotices";

function makeStore(): Record<string, unknown> {
	const store: Record<string, unknown> = {};
	store[__piSubagentPendingNotices] = new Map();
	store[__piSubagentDroppedStaleNotices] = 0;
	store[__piSubagentDedupedNotices] = 0;
	store[visibleControlNoticesStoreKey] = new Set<string>();
	return store;
}

function makeState(opts?: {
	foregroundIds?: string[];
	asyncJobs?: Array<{ asyncId: string; status: string }>;
}): SubagentState {
	const foregroundControls = new Map<string, unknown>();
	for (const id of opts?.foregroundIds ?? []) {
		foregroundControls.set(id, { runId: id });
	}
	const asyncJobs = new Map<string, { asyncId: string; status: string; asyncDir: string }>();
	for (const { asyncId, status } of opts?.asyncJobs ?? []) {
		asyncJobs.set(asyncId, { asyncId, status, asyncDir: `/tmp/async/${asyncId}` });
	}
	return {
		baseCwd: "/tmp",
		currentSessionId: null,
		asyncJobs,
		foregroundControls,
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	} as unknown as SubagentState;
}

function makeFakePi() {
	const calls: unknown[] = [];
	return {
		sendMessage(msg: unknown, opts: unknown) {
			calls.push({ msg, opts });
		},
		calls,
	};
}

function makePayload(runId: string) {
	return {
		event: buildControlEvent({ to: "stuck", runId, agent: "test-agent" }),
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("control-notice receiver gate + delivery-time deferral", () => {
	/**
	 * Test 1 (task 5.6 — no-poisoning): a stale notice arrives.
	 * Assert visibleControlNotices.size is unchanged and droppedStaleNotices=1.
	 */
	it("stale notice is dropped without poisoning the dedup set", () => {
		const store = makeStore();
		// No foregroundControls, no asyncJobs → runId is stale.
		const state = makeState();
		const visible = store[visibleControlNoticesStoreKey] as Set<string>;
		const sizeBefore = visible.size;

		processControlEvent(makePayload("run-stale"), store, state, visible);

		assert.equal(
			visible.size,
			sizeBefore,
			"visibleControlNotices must not change when notice is dropped as stale",
		);
		assert.equal(
			store[__piSubagentDroppedStaleNotices],
			1,
			"droppedStaleNotices must be 1 after a stale drop",
		);
		assert.equal(
			(store[__piSubagentPendingNotices] as Map<string, unknown>).size,
			0,
			"pending buffer must remain empty",
		);
	});

	/**
	 * Test 2: a live notice arrives via processControlEvent.
	 * Assert it lands in the pending buffer and pi.sendMessage was NOT called.
	 */
	it("live notice is buffered (not sent) at event-receive time", () => {
		const store = makeStore();
		const state = makeState({ foregroundIds: ["run-live"] });
		const visible = store[visibleControlNoticesStoreKey] as Set<string>;
		const pi = makeFakePi();

		processControlEvent(makePayload("run-live"), store, state, visible);

		const pending = store[__piSubagentPendingNotices] as Map<string, unknown>;
		assert.equal(pending.size, 1, "pending buffer must have exactly one entry");
		assert.equal(pi.calls.length, 0, "pi.sendMessage must NOT be called at event-receive time");
		assert.equal(visible.size, 0, "visibleControlNotices must not be updated until flush");
	});

	/**
	 * Test 3: notice arrives live, run terminates before flush.
	 * Assert pi.sendMessage NOT called, droppedStaleNotices=1, buffer empty.
	 */
	it("notice buffered while live is dropped at flush if run terminated", () => {
		const store = makeStore();
		const state = makeState({ foregroundIds: ["run-terminates"] });
		const visible = store[visibleControlNoticesStoreKey] as Set<string>;
		const pi = makeFakePi();

		// Notice arrives while live → goes to pending buffer.
		processControlEvent(makePayload("run-terminates"), store, state, visible);

		// Run terminates: remove from foregroundControls.
		(state.foregroundControls as Map<string, unknown>).delete("run-terminates");

		// Flush runs — re-checks liveness → now stale.
		flushPendingNotices(pi, store, state);

		assert.equal(pi.calls.length, 0, "pi.sendMessage must NOT be called for a stale-at-flush notice");
		assert.equal(store[__piSubagentDroppedStaleNotices], 1, "droppedStaleNotices must be 1");
		assert.equal(
			(store[__piSubagentPendingNotices] as Map<string, unknown>).size,
			0,
			"pending buffer must be empty after flush",
		);
	});

	/**
	 * Test 4: notice arrives live, run remains live at flush.
	 * Assert pi.sendMessage called once, dedup set has key, buffer empty.
	 */
	it("notice buffered while live is delivered at flush if run still live", () => {
		const store = makeStore();
		const state = makeState({ foregroundIds: ["run-stays-live"] });
		const visible = store[visibleControlNoticesStoreKey] as Set<string>;
		const pi = makeFakePi();

		processControlEvent(makePayload("run-stays-live"), store, state, visible);

		// Run is still live — don't remove it.
		flushPendingNotices(pi, store, state);

		assert.equal(pi.calls.length, 1, "pi.sendMessage must be called exactly once");
		assert.equal(visible.size, 1, "visibleControlNotices must contain the key after flush");
		assert.equal(
			(store[__piSubagentPendingNotices] as Map<string, unknown>).size,
			0,
			"pending buffer must be empty after flush",
		);
		// Verify the message payload shape round-trips correctly.
		const call = pi.calls[0] as { msg: { customType: string; display: boolean } };
		assert.equal(call.msg.customType, "subagent_control_notice");
		assert.equal(call.msg.display, true);
	});

	/**
	 * Test 5 (task 5.6 / Decision 6 — no-poisoning regression):
	 * Drop a stale notice with key K; then the same runId becomes live and a
	 * new notice with key K arrives; flushPendingNotices runs while live.
	 * Assert pi.sendMessage IS called (prior drop did not pollute the dedup set).
	 */
	it("prior stale drop does not poison the dedup set (key can be delivered later)", () => {
		const store = makeStore();
		const state = makeState(); // run unknown → stale initially
		const visible = store[visibleControlNoticesStoreKey] as Set<string>;
		const pi = makeFakePi();

		// First arrival: stale drop.
		processControlEvent(makePayload("run-reappears"), store, state, visible);
		assert.equal(store[__piSubagentDroppedStaleNotices], 1, "first drop should increment counter");
		assert.equal(visible.size, 0, "dedup set must be untouched after stale drop");

		// Run becomes live.
		(state.foregroundControls as Map<string, unknown>).set("run-reappears", { runId: "run-reappears" });

		// Second arrival: now live — should go to pending buffer.
		processControlEvent(makePayload("run-reappears"), store, state, visible);

		// Flush while still live → must deliver.
		flushPendingNotices(pi, store, state);

		assert.equal(pi.calls.length, 1, "pi.sendMessage must be called — prior drop must not have poisoned dedup");
		assert.equal(visible.size, 1, "dedup set must contain the key after successful delivery");
	});
});
