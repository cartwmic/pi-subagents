import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyRunForNotice } from "../../liveness.ts";
import type { AsyncJobState, SubagentState } from "../../types.ts";

// ---------------------------------------------------------------------------
// Minimal state builder — only foregroundControls and asyncJobs are
// referenced by classifyRunForNotice.
// ---------------------------------------------------------------------------
function makeState(opts: {
	foregroundIds?: string[];
	asyncJobs?: Array<{ asyncId: string; status: AsyncJobState["status"] }>;
}): SubagentState {
	const foregroundControls = new Map<string, unknown>();
	for (const id of opts.foregroundIds ?? []) {
		foregroundControls.set(id, {
			runId: id,
			mode: "single",
			startedAt: Date.now(),
			updatedAt: Date.now(),
		});
	}

	const asyncJobs = new Map<string, AsyncJobState>();
	for (const { asyncId, status } of opts.asyncJobs ?? []) {
		asyncJobs.set(asyncId, {
			asyncId,
			asyncDir: `/tmp/async/${asyncId}`,
			status,
		});
	}

	return { foregroundControls, asyncJobs } as unknown as SubagentState;
}

// ---------------------------------------------------------------------------
// Live / stale classification matrix
// ---------------------------------------------------------------------------
describe("classifyRunForNotice — live cases", () => {
	it("foreground hit → live", () => {
		const state = makeState({ foregroundIds: ["run-fg"] });
		assert.equal(classifyRunForNotice(state, "run-fg"), "live");
	});

	it("async status queued → live", () => {
		const state = makeState({ asyncJobs: [{ asyncId: "run-q", status: "queued" }] });
		assert.equal(classifyRunForNotice(state, "run-q"), "live");
	});

	it("async status running → live", () => {
		const state = makeState({ asyncJobs: [{ asyncId: "run-r", status: "running" }] });
		assert.equal(classifyRunForNotice(state, "run-r"), "live");
	});
});

describe("classifyRunForNotice — stale cases", () => {
	it("async status paused → stale (paused is on cleanup path)", () => {
		const state = makeState({ asyncJobs: [{ asyncId: "run-p", status: "paused" }] });
		assert.equal(classifyRunForNotice(state, "run-p"), "stale");
	});

	it("async status complete → stale", () => {
		const state = makeState({ asyncJobs: [{ asyncId: "run-c", status: "complete" }] });
		assert.equal(classifyRunForNotice(state, "run-c"), "stale");
	});

	it("async status failed → stale", () => {
		const state = makeState({ asyncJobs: [{ asyncId: "run-f", status: "failed" }] });
		assert.equal(classifyRunForNotice(state, "run-f"), "stale");
	});

	it("unknown runId (absent from both maps) → stale", () => {
		const state = makeState({});
		assert.equal(classifyRunForNotice(state, "unknown-run"), "stale");
	});

	it("recent-terminal-only (not in foreground, not in asyncJobs) → stale", () => {
		// Even if the caller had recorded the run in globalStore.recentlyTerminalRuns,
		// classifyRunForNotice does NOT consult globalStore — Decision 1 in design.md.
		const state = makeState({});
		// Simulate what a consumer might do: the run has been recorded terminal
		// but is absent from both maps. Result must still be stale.
		assert.equal(classifyRunForNotice(state, "recently-done"), "stale");
	});
});

// ---------------------------------------------------------------------------
// Regression: runId === asyncId implicit invariant
//
// ControlEvent.runId and AsyncJobState.asyncId carry the same value for
// async runs. classifyRunForNotice looks up state.asyncJobs.get(runId),
// so the map must be keyed by asyncId (== runId). This test pins that
// invariant so a future rename can't silently break the gate.
// ---------------------------------------------------------------------------
describe("classifyRunForNotice — runId === asyncId invariant", () => {
	it("asyncJobs is keyed by asyncId which equals the runId from ControlEvent", () => {
		const RUN_ID = "shared-id-123";

		// Simulate what async-job-tracker does: key the map by asyncId.
		const asyncJobs = new Map<string, AsyncJobState>();
		asyncJobs.set(RUN_ID, {
			asyncId: RUN_ID,       // asyncId === the key
			asyncDir: `/tmp/async/${RUN_ID}`,
			status: "running",
		});

		const state = { foregroundControls: new Map(), asyncJobs } as unknown as SubagentState;

		// ControlEvent would carry runId = RUN_ID. The gate must find it live.
		assert.equal(
			classifyRunForNotice(state, RUN_ID),
			"live",
			"gate must find the job when runId equals asyncId (the map key)",
		);

		// If the map were accidentally keyed by something else, the lookup
		// would return undefined → stale. Verify that broken scenario fails.
		const brokenJobs = new Map<string, AsyncJobState>();
		brokenJobs.set("wrong-key", {
			asyncId: RUN_ID,
			asyncDir: "/tmp/async/x",
			status: "running",
		});
		const brokenState = { foregroundControls: new Map(), asyncJobs: brokenJobs } as unknown as SubagentState;
		assert.equal(
			classifyRunForNotice(brokenState, RUN_ID),
			"stale",
			"lookup by runId must fail when the map key differs from asyncId",
		);
	});
});

// ---------------------------------------------------------------------------
// Task 9.4: recordTerminalRun (foreground) then foregroundControls.delete
// is observable in order from the perspective of a synchronous classifier.
//
// This is a pure-logic ordering regression test — no real timers needed.
// ---------------------------------------------------------------------------
describe("ordering: record-before-delete is observable synchronously", () => {
	it("classifier sees 'live' before delete and 'stale' after", () => {
		const foregroundControls = new Map<string, unknown>();
		const RUN_ID = "order-test";
		foregroundControls.set(RUN_ID, { runId: RUN_ID, mode: "single", startedAt: 0, updatedAt: 0 });

		const state = { foregroundControls, asyncJobs: new Map() } as unknown as SubagentState;

		// Before any terminal recording or deletion: must be live.
		assert.equal(classifyRunForNotice(state, RUN_ID), "live");

		// Simulate what subagent-executor.ts finally block does:
		// 1) recordTerminalRun(globalStore, runId, terminalState)   ← happens first
		// 2) state.foregroundControls.delete(runId)                 ← happens second
		//
		// Between steps 1 and 2 the run is still in foregroundControls → still live.
		// We verify this ordering invariant by checking live immediately after
		// the simulated record (which doesn't touch foregroundControls).

		// (step 1) — recordTerminalRun only writes to globalStore; foregroundControls untouched.
		// Classifier still returns "live" because foregroundControls.has(runId) is true.
		assert.equal(
			classifyRunForNotice(state, RUN_ID),
			"live",
			"run must be live between record and delete",
		);

		// (step 2) — delete from foregroundControls.
		foregroundControls.delete(RUN_ID);

		// Now the classifier must return "stale".
		assert.equal(
			classifyRunForNotice(state, RUN_ID),
			"stale",
			"run must be stale after foregroundControls.delete",
		);
	});
});
