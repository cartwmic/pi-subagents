/**
 * Integration tests for the control-notice liveness gate (Section 10).
 *
 * Covers:
 *  - 10.1  Receiver-side gate: live → buffer; stale → drop with counter
 *  - 10.3  Async-tracker disk-replay drops events for terminated runs
 *  - 10.4  Dedupe-poisoning: a dropped stale notice does NOT mark the
 *          dedup key, so a later live recurrence still publishes
 *  - 10.5  Doctor surfaces the four counters
 *  - 11.3  THE critical test: notice buffered while live, run terminates
 *          before flush; flush drops it without calling pi.sendMessage
 *          and increments droppedStaleNotices by 1 (the user-reported
 *          false-alarm shape)
 *
 * Uses the .ts → .js loader registered via test/support/register-loader.mjs.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createEventBus, createTempDir, removeTempDir, tryImport } from "../support/helpers.ts";
import type { SubagentState } from "../../types.ts";
import { SUBAGENT_CONTROL_EVENT, SUBAGENT_CONTROL_INTERCOM_EVENT } from "../../types.ts";

// ---------------------------------------------------------------------------
// Module imports
// ---------------------------------------------------------------------------
const indexMod = await tryImport<any>("./index.ts");
const {
	processControlEvent,
	flushPendingNotices,
} = indexMod ?? {};

const trackerMod = await tryImport<any>("./async-job-tracker.ts");
const createAsyncJobTracker = trackerMod?.createAsyncJobTracker;

const doctorMod = await tryImport<any>("./doctor.ts");
const buildDoctorReport = doctorMod?.buildDoctorReport;

const recentTerminalMod = await tryImport<any>("./recent-terminal.ts");
const recordTerminalRun = recentTerminalMod?.recordTerminalRun;

// improve-control-notice-tuning Section 4: pending-notices buffer replaced by
// per-runId coalesce buffer (__piSubagentControlNoticeBuffers).
const STORE_KEYS = [
	"__piSubagentRecentlyTerminalRuns",
	"__piSubagentDroppedStaleNotices",
	"__piSubagentDedupedNotices",
	"__piSubagentControlNoticeBuffers",
	"__piSubagentSyncFlushDedup",
	"__piSubagentRunFlushEpoch",
	"__piSubagentVisibleControlNotices",
];

function freshGlobalStore(): Record<string, unknown> {
	const store: Record<string, unknown> = {};
	store.__piSubagentRecentlyTerminalRuns = new Map();
	store.__piSubagentControlNoticeBuffers = new Map();
	store.__piSubagentSyncFlushDedup = new Map();
	store.__piSubagentRunFlushEpoch = new Map();
	store.__piSubagentDroppedStaleNotices = 0;
	store.__piSubagentDedupedNotices = 0;
	store.__piSubagentVisibleControlNotices = new Set<string>();
	for (const key of STORE_KEYS) (globalThis as any)[key] = store[key];
	return store;
}

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

function makePiStub() {
	const sent: Array<{ msg: unknown; opts: unknown }> = [];
	return {
		sent,
		sendMessage(msg: unknown, opts: unknown) {
			sent.push({ msg, opts });
		},
	};
}

function makeNoticePayload(runId: string, agent = "test-agent", index?: number, opts: { coalesceWindowMs?: number } = {}) {
	return {
		event: {
			type: "needs_attention",
			runId,
			to: "stuck",
			ts: Date.now(),
			agent,
			index,
			message: `notice for ${runId}`,
		},
		source: "foreground",
		noticeText: `notice for ${runId}`,
		// Default to a long window so events are buffered (not sync-flushed) for
		// these tests; individual tests override to 0 when sync flush is desired.
		coalesceWindowMs: opts.coalesceWindowMs ?? 1000,
	};
}

// ---------------------------------------------------------------------------
// 10.1 + 11.3
// ---------------------------------------------------------------------------
describe("control-notice liveness gate — receiver-side + delivery-time", () => {
	let store: Record<string, unknown>;
	let state: SubagentState;
	let visible: Set<string>;
	let pi: ReturnType<typeof makePiStub>;

	beforeEach(() => {
		store = freshGlobalStore();
		state = makeState();
		visible = store.__piSubagentVisibleControlNotices as Set<string>;
		pi = makePiStub();
	});

	it("10.1a buffers a live foreground notice (no immediate sendMessage)", () => {
		const runId = "live-fg-run";
		state.foregroundControls.set(runId, { runId } as never);

		processControlEvent(makeNoticePayload(runId), store, state, visible);

		const buffers = store.__piSubagentControlNoticeBuffers as Map<string, { events: unknown[] }>;
		assert.equal(buffers.size, 1, "coalesce buffer should hold one runId");
		assert.equal(buffers.get(runId)?.events.length, 1, "buffer should hold one event");
		assert.equal(pi.sent.length, 0, "live notice should NOT sendMessage yet");
		assert.equal(visible.size, 0, "dedup set should NOT be touched at receive time");
	});

	it("10.1b drops a notice for an unknown run + increments droppedStaleNotices", () => {
		// Use sync-flush (window=0) so the gate runs immediately and the drop
		// counter increments in this tick.
		(store as { __piSubagentLastPi?: unknown }).__piSubagentLastPi = pi;
		processControlEvent(makeNoticePayload("ghost-run", "test-agent", undefined, { coalesceWindowMs: 0 }), store, state, visible);

		assert.equal(store.__piSubagentDroppedStaleNotices, 1);
		const buffers = store.__piSubagentControlNoticeBuffers as Map<string, unknown>;
		assert.equal(buffers.size, 0, "coalesce buffer must be empty after sync flush of stale notice");
		assert.equal(visible.size, 0, "dropped notice does NOT poison dedup");
	});

	it("11.3 (CRITICAL) — buffered-while-live, terminate before flush, drop at flush", () => {
		const runId = "buffered-then-terminated";
		// 1. Run is live; receiver buffers the notice (window=1000 so timer is set).
		state.foregroundControls.set(runId, { runId } as never);
		processControlEvent(makeNoticePayload(runId), store, state, visible);
		const buffers = store.__piSubagentControlNoticeBuffers as Map<string, { events: unknown[] }>;
		assert.equal(buffers.get(runId)?.events.length, 1);

		// 2. Run terminates: record terminal + delete from foregroundControls.
		recordTerminalRun(store, runId, "succeeded");
		state.foregroundControls.delete(runId);

		// 3. Flush — at this moment the run is stale.
		flushPendingNotices(pi, store, state);

		// 4. Assertions.
		assert.equal(pi.sent.length, 0, "no sendMessage for the now-stale run");
		assert.equal(store.__piSubagentDroppedStaleNotices, 1, "droppedStaleNotices += 1");
		assert.equal(buffers.size, 0, "buffer drained");
	});

	it("11.3 happy-path counterpart — buffered-while-live, still live at flush, delivered", () => {
		const runId = "buffered-and-stays-live";
		state.foregroundControls.set(runId, { runId } as never);
		processControlEvent(makeNoticePayload(runId), store, state, visible);

		flushPendingNotices(pi, store, state);

		assert.equal(pi.sent.length, 1, "live notice delivered at flush");
		assert.equal(store.__piSubagentDroppedStaleNotices, 0);
		assert.equal(visible.size, 1, "dedup set updated at delivery time");
	});

	it("10.4 dropped stale notice does NOT poison the dedup set (later live recurrence still publishes)", () => {
		const runId = "key-recycle-run";
		(store as { __piSubagentLastPi?: unknown }).__piSubagentLastPi = pi;

		// (a) sync-flush (window=0) drop a stale notice with the key.
		processControlEvent(
			makeNoticePayload(runId, "test-agent", undefined, { coalesceWindowMs: 0 }),
			store,
			state,
			visible,
		);
		assert.equal(store.__piSubagentDroppedStaleNotices, 1);
		assert.equal(visible.size, 0, "drop must not touch dedup set");

		// (b) the run becomes live; same key arrives. Use sync-flush so it
		// publishes on the spot. The per-runId epoch advances on publish, so
		// future duplicates in the same window are still suppressed by the
		// sync-dedup map; here we only assert the first one publishes.
		state.foregroundControls.set(runId, { runId } as never);
		// Bump ts past the SYNC_DEDUP_WINDOW_MS so the prior stale-drop ts
		// doesn't suppress this one.
		processControlEvent(
			{
				event: {
					type: "needs_attention",
					runId,
					to: "stuck",
					ts: Date.now() + 5000,
					agent: "test-agent",
					message: `notice for ${runId}`,
				},
				source: "foreground",
				noticeText: `notice for ${runId}`,
				coalesceWindowMs: 0,
			},
			store,
			state,
			visible,
		);

		assert.equal(pi.sent.length, 1, "live recurrence with same key publishes");
	});
});

// ---------------------------------------------------------------------------
// 10.3 — async-tracker disk-replay drops events for terminated runs
// ---------------------------------------------------------------------------
describe("control-notice liveness gate — async-tracker disk replay", () => {
	let tempRoot: string;

	beforeEach(() => {
		freshGlobalStore();
		tempRoot = createTempDir("pi-cnl-async-");
	});
	afterEach(() => {
		removeTempDir(tempRoot);
	});

	it("10.3 emitNewControlEvents drops events for an asyncJob that has reached `complete`", async () => {
		if (!createAsyncJobTracker) return; // module unavailable in this test env

		const runId = "async-replay-stale";
		const asyncDir = path.join(tempRoot, runId);
		fs.mkdirSync(asyncDir, { recursive: true });

		// status.json reports complete (runner already terminated).
		fs.writeFileSync(
			path.join(asyncDir, "status.json"),
			JSON.stringify({
				runId,
				mode: "single",
				state: "complete",
				startedAt: Date.now(),
				lastUpdate: Date.now(),
			}),
		);
		// events.jsonl carries a needs_attention line (race: written before terminal flush).
		fs.writeFileSync(
			path.join(asyncDir, "events.jsonl"),
			`${JSON.stringify({
				type: "subagent.control",
				event: {
					type: "needs_attention",
					runId,
					to: "stuck",
					ts: Date.now(),
					agent: "ag",
					message: "stale-by-now",
				},
				channels: ["event"],
				noticeText: "stale-by-now",
			})}\n`,
		);

		const state = makeState();
		const emits: string[] = [];
		const pi = {
			events: {
				emit(channel: string) {
					emits.push(channel);
					return true;
				},
			},
		};
		const tracker = createAsyncJobTracker(pi as never, state, tempRoot, {
			pollIntervalMs: 1,
			completionRetentionMs: 60_000,
		});
		tracker.handleStarted({ id: runId, asyncDir });
		// Force status to "complete" BEFORE poll fires so the gate definitely sees stale.
		state.asyncJobs.get(runId)!.status = "complete";

		await new Promise<void>((res) => setTimeout(res, 50));

		// Cleanup intervals.
		if (state.poller) clearInterval(state.poller);
		for (const t of state.cleanupTimers.values()) clearTimeout(t);

		assert.equal(
			emits.filter((c) => c === SUBAGENT_CONTROL_EVENT).length,
			0,
			"SUBAGENT_CONTROL_EVENT must be gated for terminal asyncJob",
		);
		assert.equal(
			emits.filter((c) => c === SUBAGENT_CONTROL_INTERCOM_EVENT).length,
			0,
			"SUBAGENT_CONTROL_INTERCOM_EVENT must be gated too",
		);
	});
});

// ---------------------------------------------------------------------------
// 10.5 — doctor report surfaces the four counters
// ---------------------------------------------------------------------------
describe("control-notice liveness gate — doctor surface", () => {
	it("10.5 doctor reports dropped/deduped/recently-terminal/pending counters", () => {
		if (!buildDoctorReport) return;

		const store = freshGlobalStore();
		store.__piSubagentDroppedStaleNotices = 7;
		store.__piSubagentDedupedNotices = 3;
		const recently = store.__piSubagentRecentlyTerminalRuns as Map<string, unknown>;
		recently.set("r1", { terminatedAt: Date.now() - 1234, terminalState: "succeeded" });
		recently.set("r2", { terminatedAt: Date.now() - 500, terminalState: "failed" });
		// improve-control-notice-tuning: doctor still reports a `pending notices`
		// line; the source map is now `__piSubagentControlNoticeBuffers`. Add
		// one buffered runId to assert the count.
		const buffers = store.__piSubagentControlNoticeBuffers as Map<string, unknown>;
		buffers.set("x", {
			events: [{ event: { runId: "x" }, noticeText: "y" }],
			openedAt: Date.now(),
			needsAttentionAfterMs: 60_000,
			coalesceWindowMs: 1000,
			childIntercomTargets: new Map(),
			dedupKeys: new Set(),
		});

		const state = makeState();
		const report = buildDoctorReport({
			cwd: process.cwd(),
			config: {
				asyncByDefault: false,
				intercomBridge: undefined,
			},
			state,
			globalStore: store,
			deps: {
				isAsyncAvailable: () => true,
				discoverAgentsAll: () => ({ builtin: [], user: [], project: [], chains: [] }),
				discoverAvailableSkills: () => [],
				diagnoseIntercomBridge: () => ({
					active: false,
					mode: "off",
					orchestratorTarget: undefined,
					piIntercomAvailable: false,
					extensionDir: "/dev/null",
				}),
			},
		});

		assert.match(report, /Control notices/);
		assert.match(report, /dropped stale notices: 7/);
		assert.match(report, /deduped notices: 3/);
		assert.match(report, /recently-terminal runs: 2/);
		assert.match(report, /pending notices: 1/);
		assert.match(report, /dropped coalesce overflow: 0/);
	});

	it("10.5b doctor degrades gracefully when globalStore is absent", () => {
		if (!buildDoctorReport) return;
		const state = makeState();
		const report = buildDoctorReport({
			cwd: process.cwd(),
			config: { asyncByDefault: false, intercomBridge: undefined },
			state,
			deps: {
				isAsyncAvailable: () => true,
				discoverAgentsAll: () => ({ builtin: [], user: [], project: [], chains: [] }),
				discoverAvailableSkills: () => [],
				diagnoseIntercomBridge: () => ({
					active: false,
					mode: "off",
					orchestratorTarget: undefined,
					piIntercomAvailable: false,
					extensionDir: "/dev/null",
				}),
			},
		});
		assert.match(report, /Control notices/);
		assert.match(report, /recently-terminal runs: 0 \(oldest: \(empty\)\)/);
	});
});
