/**
 * Integration tests for foreground + recently-terminal lookup
 * (add-foreground-run-status-lookup change).
 *
 * Covers:
 *  - 11.1  Register a foreground control, query, assert enrichment fields
 *  - 11.2  Recently-terminal within TTL → response; past TTL → not-found
 *  - 11.3  Race: recordTerminalRun → foregroundControls.delete; query at
 *          each interleaving point; never not-found
 *  - 11.4  End-to-end "control notice → status query": foreground while
 *          live, recently-terminal after termination
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SubagentState } from "../../types.ts";
import { tryImport } from "../support/helpers.ts";

const runStatusMod = await tryImport<any>("./run-status.ts");
const inspectSubagentStatus = runStatusMod?.inspectSubagentStatus;

const recentTerminalMod = await tryImport<any>("./recent-terminal.ts");
const recordTerminalRun = recentTerminalMod?.recordTerminalRun;
const RECENT_TERMINAL_TTL_MS = recentTerminalMod?.RECENT_TERMINAL_TTL_MS ?? 30_000;

function makeState(): SubagentState {
	return {
		baseCwd: "/tmp",
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
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

function registerForeground(state: SubagentState, runId: string, currentAgent = "worker"): void {
	state.foregroundControls.set(runId, {
		runId,
		mode: "single",
		startedAt: Date.now() - 8_000,
		updatedAt: Date.now(),
		currentAgent,
		lastActivityAt: Date.now() - 2_000,
		currentActivityState: "needs_attention",
		interrupt: () => false,
	} as never);
	state.lastForegroundControlId = runId;
}

describe("inspectSubagentStatus — foreground + recently-terminal end-to-end", () => {
	it("11.1 foreground hit returns enriched response", () => {
		const state = makeState();
		registerForeground(state, "fg-int-1");
		const result = inspectSubagentStatus({ id: "fg-int-1" }, state, {});
		assert.equal(result.details?.lookup, "foreground");
		assert.equal(result.details?.id, "fg-int-1");
		assert.equal(result.details?.runMode, "single");
		assert.equal(result.details?.currentAgent, "worker");
		assert.equal(result.details?.activityState, "needs_attention");
		assert.ok((result.details?.durationMs ?? 0) > 0);
		assert.match(result.content[0]?.text ?? "", /Run: fg-int-1/);
		assert.match(result.content[0]?.text ?? "", /Activity:/);
	});

	it("11.2 recently-terminal within TTL → response; past TTL → not-found", () => {
		const store: Record<string, unknown> = {};
		// Within TTL.
		recordTerminalRun(store, "rt-fresh", "succeeded");
		const fresh = inspectSubagentStatus({ id: "rt-fresh" }, makeState(), store);
		assert.equal(fresh.details?.lookup, "recently-terminal");
		assert.equal(fresh.details?.terminalState, "succeeded");

		// Past TTL: forge an old terminatedAt directly on the map.
		const map = store.__piSubagentRecentlyTerminalRuns as Map<string, any>;
		map.set("rt-stale", {
			terminatedAt: Date.now() - (RECENT_TERMINAL_TTL_MS + 5_000),
			terminalState: "failed",
		});
		const stale = inspectSubagentStatus({ id: "rt-stale" }, makeState(), store);
		assert.equal(stale.isError, true);
		assert.match(stale.content[0]?.text ?? "", /Async run not found/);
	});

	it("11.3 race ordering: pre-record / post-record-pre-delete / post-delete", () => {
		const state = makeState();
		const store: Record<string, unknown> = {};
		const runId = "race-run-1";
		registerForeground(state, runId);

		// Phase A: still live → foreground.
		const phaseA = inspectSubagentStatus({ id: runId }, state, store);
		assert.equal(phaseA.details?.lookup, "foreground");

		// Phase B: terminal recorded but foregroundControls not yet deleted →
		// foreground still wins (precedence: foreground beats recently-terminal).
		recordTerminalRun(store, runId, "succeeded");
		const phaseB = inspectSubagentStatus({ id: runId }, state, store);
		assert.equal(phaseB.details?.lookup, "foreground");

		// Phase C: foregroundControls.delete after recordTerminalRun → recently-terminal.
		state.foregroundControls.delete(runId);
		const phaseC = inspectSubagentStatus({ id: runId }, state, store);
		assert.equal(phaseC.details?.lookup, "recently-terminal");
		assert.equal(phaseC.details?.terminalState, "succeeded");

		// Verify: the user-visible "Async run not found" is NEVER produced
		// during this race window. (Bug pre-condition was that foreground
		// removal happened before terminal recording, leaving a gap.)
	});

	it("11.4 end-to-end: needs_attention while live → recently-terminal after termination", () => {
		const state = makeState();
		const store: Record<string, unknown> = {};
		const runId = "e2e-run";

		// (1) Live with needs_attention.
		registerForeground(state, runId);
		const live = inspectSubagentStatus({ id: runId }, state, store);
		assert.equal(live.details?.activityState, "needs_attention");
		assert.equal(live.details?.lookup, "foreground");

		// (2) Run ends (terminal record + foreground delete).
		recordTerminalRun(store, runId, "interrupted");
		state.foregroundControls.delete(runId);

		// (3) Subsequent status query gets a useful answer.
		const ended = inspectSubagentStatus({ id: runId }, state, store);
		assert.equal(ended.details?.lookup, "recently-terminal");
		assert.equal(ended.details?.terminalState, "interrupted");
		assert.match(
			ended.content[0]?.text ?? "",
			/ended \d+s ago \(interrupted\); full transcript no longer in memory/,
		);
	});

	it("no-id with foreground present → returns latest foreground", () => {
		const state = makeState();
		registerForeground(state, "noid-fg");
		const result = inspectSubagentStatus({}, state, {});
		assert.equal(result.details?.lookup, "foreground");
		assert.equal(result.details?.id, "noid-fg");
	});
});
