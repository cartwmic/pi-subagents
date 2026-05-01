/**
 * Unit tests for the consolidated `inspectSubagentStatus` lookup
 * (add-foreground-run-status-lookup change).
 *
 * Covers:
 *  - Section 4 foreground branch (exact id, prefix, ambiguous-prefix error)
 *  - Section 5 recently-terminal branch (TTL gate, prefix, ambiguity)
 *  - Section 7 executor pre-check removal (foreground hit must come from
 *    `inspectSubagentStatus`, not a pre-check)
 *  - Section 8 no-id three-tier fallback
 *  - 10.2 `details.lookup` is present on every successful response
 *  - 10.3 `details.mode === "management"` for foreground/recently-terminal;
 *    `details.mode === "single"` for async/results
 *  - 10.4 needs_attention activityState is propagated
 *  - 10.5 no-id path returns aggregator overview when no foreground exists
 *  - Defensive optional chaining when state/globalStore are undefined
 *
 * No file I/O is exercised here (async/results branches require disk
 * fixtures and are covered by the integration tests).
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { SubagentState } from "../../types.ts";
import { inspectSubagentStatus } from "../../run-status.ts";
import {
	RECENT_TERMINAL_TTL_MS,
	type RecentTerminalEntry,
} from "../../recent-terminal.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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

function makeForegroundControl(overrides: Partial<{
	runId: string;
	mode: "single" | "parallel" | "chain";
	startedAt: number;
	updatedAt: number;
	currentAgent: string;
	currentIndex: number;
	currentActivityState: string;
	lastActivityAt: number;
}> = {}): any {
	return {
		runId: overrides.runId ?? "fg-1",
		mode: overrides.mode ?? "single",
		startedAt: overrides.startedAt ?? Date.now() - 5_000,
		updatedAt: overrides.updatedAt ?? Date.now(),
		currentAgent: overrides.currentAgent,
		currentIndex: overrides.currentIndex,
		currentActivityState: overrides.currentActivityState,
		lastActivityAt: overrides.lastActivityAt,
		interrupt: () => false,
	};
}

function makeStoreWithRecentlyTerminal(
	entries: Array<[string, RecentTerminalEntry]> = [],
): Record<string, unknown> {
	const map = new Map<string, RecentTerminalEntry>(entries);
	return { __piSubagentRecentlyTerminalRuns: map };
}

// ---------------------------------------------------------------------------
// Section 4 — foreground branch
// ---------------------------------------------------------------------------
describe("inspectSubagentStatus — foreground branch (Section 4)", () => {
	let state: SubagentState;
	beforeEach(() => {
		state = makeState();
	});

	it("4.1 exact-id hit returns foreground response", () => {
		state.foregroundControls.set(
			"fg-exact",
			makeForegroundControl({ runId: "fg-exact", currentAgent: "worker" }) as never,
		);
		const result = inspectSubagentStatus({ id: "fg-exact" }, state, {});
		assert.equal(result.isError, undefined);
		assert.equal(result.details?.lookup, "foreground");
		assert.equal(result.details?.id, "fg-exact");
		assert.equal(result.details?.mode, "management");
		assert.equal(result.details?.runMode, "single");
		assert.equal(result.details?.currentAgent, "worker");
	});

	it("4.2 unique prefix matches", () => {
		state.foregroundControls.set("alpha-1234567", makeForegroundControl({ runId: "alpha-1234567" }) as never);
		state.foregroundControls.set("beta-9999999", makeForegroundControl({ runId: "beta-9999999" }) as never);
		const result = inspectSubagentStatus({ id: "alpha" }, state, {});
		assert.equal(result.details?.lookup, "foreground");
		assert.equal(result.details?.id, "alpha-1234567");
	});

	it("4.2 ambiguous prefix returns error", () => {
		state.foregroundControls.set("dup-1111111", makeForegroundControl({ runId: "dup-1111111" }) as never);
		state.foregroundControls.set("dup-2222222", makeForegroundControl({ runId: "dup-2222222" }) as never);
		const result = inspectSubagentStatus({ id: "dup" }, state, {});
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Ambiguous prefix 'dup'/);
	});

	it("4.3 enrichment fields populated (durationMs, runMode, lastActivityAt, activityState)", () => {
		const startedAt = Date.now() - 12_000;
		const lastActivityAt = Date.now() - 3_000;
		state.foregroundControls.set(
			"fg-rich",
			makeForegroundControl({
				runId: "fg-rich",
				mode: "parallel",
				startedAt,
				lastActivityAt,
				currentActivityState: "needs_attention",
			}) as never,
		);
		const result = inspectSubagentStatus({ id: "fg-rich" }, state, {});
		assert.equal(result.details?.runMode, "parallel");
		assert.equal(result.details?.activityState, "needs_attention");
		assert.equal(result.details?.lastActivityAt, lastActivityAt);
		assert.ok((result.details?.durationMs ?? 0) >= 12_000);
	});

	it("10.4 currentActivityState=needs_attention propagates to details.activityState", () => {
		state.foregroundControls.set(
			"fg-na",
			makeForegroundControl({ runId: "fg-na", currentActivityState: "needs_attention" }) as never,
		);
		const result = inspectSubagentStatus({ id: "fg-na" }, state, {});
		assert.equal(result.details?.activityState, "needs_attention");
	});
});

// ---------------------------------------------------------------------------
// Section 5 — recently-terminal branch
// ---------------------------------------------------------------------------
describe("inspectSubagentStatus — recently-terminal branch (Section 5)", () => {
	it("5.1 + 5.2 within-TTL hit returns recently-terminal response", () => {
		const store = makeStoreWithRecentlyTerminal([
			["term-fresh", { terminatedAt: Date.now() - 1_000, terminalState: "succeeded" }],
		]);
		const result = inspectSubagentStatus({ id: "term-fresh" }, makeState(), store);
		assert.equal(result.isError, undefined);
		assert.equal(result.details?.lookup, "recently-terminal");
		assert.equal(result.details?.terminalState, "succeeded");
		assert.equal(result.details?.mode, "management");
		assert.match(result.content[0]?.text ?? "", /ended \d+s ago \(succeeded\)/);
	});

	it("5.2 past-TTL entry is treated as miss", () => {
		const store = makeStoreWithRecentlyTerminal([
			["term-stale", {
				terminatedAt: Date.now() - (RECENT_TERMINAL_TTL_MS + 1_000),
				terminalState: "failed",
			}],
		]);
		const result = inspectSubagentStatus({ id: "term-stale" }, makeState(), store);
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Async run not found/);
	});

	it("5.3 prefix scan with TTL filter resolves unique fresh entry", () => {
		const store = makeStoreWithRecentlyTerminal([
			["fresh-aaaa", { terminatedAt: Date.now() - 500, terminalState: "succeeded" }],
			["other-bbbb", { terminatedAt: Date.now() - 500, terminalState: "succeeded" }],
		]);
		const result = inspectSubagentStatus({ id: "fresh" }, makeState(), store);
		assert.equal(result.details?.lookup, "recently-terminal");
		assert.equal(result.details?.id, "fresh-aaaa");
	});

	it("5.3 prefix scan rejects past-TTL candidate (so unique fresh sibling resolves)", () => {
		const store = makeStoreWithRecentlyTerminal([
			["x-fresh", { terminatedAt: Date.now() - 500, terminalState: "succeeded" }],
			["x-stale", {
				terminatedAt: Date.now() - (RECENT_TERMINAL_TTL_MS + 1_000),
				terminalState: "failed",
			}],
		]);
		const result = inspectSubagentStatus({ id: "x-" }, makeState(), store);
		assert.equal(result.details?.lookup, "recently-terminal");
		assert.equal(result.details?.id, "x-fresh");
	});

	it("5.3 ambiguous prefix among fresh entries returns error", () => {
		const store = makeStoreWithRecentlyTerminal([
			["a1-aaa", { terminatedAt: Date.now() - 500, terminalState: "succeeded" }],
			["a2-bbb", { terminatedAt: Date.now() - 500, terminalState: "succeeded" }],
		]);
		const result = inspectSubagentStatus({ id: "a" }, makeState(), store);
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Ambiguous prefix 'a'/);
	});
});

// ---------------------------------------------------------------------------
// Precedence + lookup discriminator
// ---------------------------------------------------------------------------
describe("inspectSubagentStatus — precedence + discriminator", () => {
	it("foreground beats recently-terminal", () => {
		const state = makeState();
		state.foregroundControls.set(
			"both-1",
			makeForegroundControl({ runId: "both-1", currentAgent: "fg-agent" }) as never,
		);
		const store = makeStoreWithRecentlyTerminal([
			["both-1", { terminatedAt: Date.now() - 500, terminalState: "succeeded" }],
		]);
		const result = inspectSubagentStatus({ id: "both-1" }, state, store);
		assert.equal(result.details?.lookup, "foreground");
	});

	it("10.3 mode === 'management' for foreground", () => {
		const state = makeState();
		state.foregroundControls.set("m-1", makeForegroundControl({ runId: "m-1" }) as never);
		const result = inspectSubagentStatus({ id: "m-1" }, state, {});
		assert.equal(result.details?.mode, "management");
	});

	it("10.3 mode === 'management' for recently-terminal", () => {
		const store = makeStoreWithRecentlyTerminal([
			["m-2", { terminatedAt: Date.now() - 500, terminalState: "succeeded" }],
		]);
		const result = inspectSubagentStatus({ id: "m-2" }, makeState(), store);
		assert.equal(result.details?.mode, "management");
	});
});

// ---------------------------------------------------------------------------
// Section 8 — no-id three-tier fallback
// ---------------------------------------------------------------------------
describe("inspectSubagentStatus — no-id three-tier fallback (Section 8)", () => {
	it("8.3a Tier 1: lastForegroundControlId resolves to foreground response", () => {
		const state = makeState();
		state.foregroundControls.set(
			"fg-tier1",
			makeForegroundControl({ runId: "fg-tier1", currentAgent: "tier1" }) as never,
		);
		state.lastForegroundControlId = "fg-tier1";
		const result = inspectSubagentStatus({}, state, {});
		assert.equal(result.details?.lookup, "foreground");
		assert.equal(result.details?.id, "fg-tier1");
	});

	it("8.3b/c Tier 2: lastForegroundControlId null → newest by updatedAt wins", () => {
		const state = makeState();
		const olderAt = Date.now() - 30_000;
		const newerAt = Date.now() - 1_000;
		state.foregroundControls.set("older", makeForegroundControl({ runId: "older", updatedAt: olderAt }) as never);
		state.foregroundControls.set("newer", makeForegroundControl({ runId: "newer", updatedAt: newerAt }) as never);
		state.lastForegroundControlId = null;
		const result = inspectSubagentStatus({}, state, {});
		assert.equal(result.details?.lookup, "foreground");
		assert.equal(result.details?.id, "newer");
	});

	it("8.3d Tier 3: aggregator returned when no foreground exists", () => {
		const result = inspectSubagentStatus({}, makeState(), {});
		// Aggregator path produces details.mode==="single", no lookup discriminator.
		assert.equal(result.details?.mode, "single");
		assert.equal(result.details?.lookup, undefined);
	});

	it("8.4 params.dir bypasses foreground/recently-terminal branches", () => {
		const state = makeState();
		state.foregroundControls.set("fg-shadow", makeForegroundControl({ runId: "fg-shadow" }) as never);
		const store = makeStoreWithRecentlyTerminal([
			["term-shadow", { terminatedAt: Date.now() - 500, terminalState: "succeeded" }],
		]);
		// dir resolution will fail (no real dir), but the response must NOT
		// fall through to foreground/recently-terminal — it must report the
		// dir-based not-found.
		const result = inspectSubagentStatus(
			{ dir: "/dev/definitely-not-a-real-async-dir-1234" },
			state,
			store,
		);
		assert.equal(result.isError, true);
		assert.equal(result.details?.lookup, undefined);
	});
});

// ---------------------------------------------------------------------------
// Defensive optional chaining
// ---------------------------------------------------------------------------
describe("inspectSubagentStatus — defensive guards", () => {
	it("legacy 1-arg call (no state/globalStore) reports not-found cleanly", () => {
		const result = inspectSubagentStatus({ id: "absent" });
		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Async run not found/);
	});

	it("foreground/recently-terminal lookups skipped when state/globalStore are undefined", () => {
		const result = inspectSubagentStatus({ id: "absent" }, undefined, undefined);
		assert.equal(result.isError, true);
		// Should not throw on `state.foregroundControls` access etc.
	});

	it("partial state (no foregroundControls) does not throw", () => {
		const partial = { asyncJobs: new Map() } as unknown as SubagentState;
		const result = inspectSubagentStatus({ id: "absent" }, partial, {});
		assert.equal(result.isError, true);
	});
});
