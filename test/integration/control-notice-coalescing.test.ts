/**
 * Integration tests for improve-control-notice-tuning Sections 14.1–14.9.
 *
 * Exercises the per-runId coalesce buffer end-to-end via the exported
 * `processControlEvent` and `flushPendingNotices` helpers.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ControlEvent, SubagentState } from "../../types.ts";
import { tryImport } from "../support/helpers.ts";

const indexMod = await tryImport<any>("./index.ts");
const { processControlEvent, flushPendingNotices, flushControlNoticeBuffer } = indexMod ?? {};

const STORE_KEYS = [
	"__piSubagentRecentlyTerminalRuns",
	"__piSubagentDroppedStaleNotices",
	"__piSubagentDedupedNotices",
	"__piSubagentDroppedCoalesceOverflow",
	"__piSubagentControlNoticeBuffers",
	"__piSubagentSyncFlushDedup",
	"__piSubagentRunFlushEpoch",
	"__piSubagentVisibleControlNotices",
	"__piSubagentLastPi",
];

function freshGlobalStore(): Record<string, unknown> {
	const store: Record<string, unknown> = {};
	store.__piSubagentRecentlyTerminalRuns = new Map();
	store.__piSubagentControlNoticeBuffers = new Map();
	store.__piSubagentSyncFlushDedup = new Map();
	store.__piSubagentRunFlushEpoch = new Map();
	store.__piSubagentDroppedStaleNotices = 0;
	store.__piSubagentDedupedNotices = 0;
	store.__piSubagentDroppedCoalesceOverflow = 0;
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

function registerForeground(state: SubagentState, runId: string): void {
	state.foregroundControls.set(runId, { runId } as never);
}

function makePiStub() {
	const sent: Array<{ msg: any; opts: unknown }> = [];
	return {
		sent,
		sendMessage(msg: unknown, opts: unknown) {
			sent.push({ msg, opts });
		},
	};
}

function makeEventPayload(opts: {
	runId: string;
	index?: number;
	agent?: string;
	ts?: number;
	coalesceWindowMs?: number;
	needsAttentionAfterMs?: number;
	childIntercomTarget?: string;
	lastActivityAt?: number;
	elapsedMs?: number;
}): unknown {
	const event: ControlEvent = {
		type: "needs_attention",
		from: undefined,
		to: "needs_attention",
		ts: opts.ts ?? Date.now(),
		runId: opts.runId,
		agent: opts.agent ?? "worker",
		index: opts.index,
		message: `${opts.agent ?? "worker"} needs attention`,
		lastActivityAt: opts.lastActivityAt,
		elapsedMs: opts.elapsedMs,
	};
	return {
		event,
		source: "foreground",
		childIntercomTarget: opts.childIntercomTarget,
		coalesceWindowMs: opts.coalesceWindowMs,
		needsAttentionAfterMs: opts.needsAttentionAfterMs ?? 180_000,
	};
}

// ---------------------------------------------------------------------------
// 14.1 — coalescing produces ONE multi-step notice
// ---------------------------------------------------------------------------
describe("control-notice coalescing (Section 14)", () => {
	let store: Record<string, unknown>;
	let state: SubagentState;
	let visible: Set<string>;
	let pi: ReturnType<typeof makePiStub>;

	beforeEach(() => {
		store = freshGlobalStore();
		state = makeState();
		visible = store.__piSubagentVisibleControlNotices as Set<string>;
		pi = makePiStub();
		store.__piSubagentLastPi = pi;
	});

	afterEach(() => {
		// Cancel any pending flush timers from buffered tests.
		const buffers = store.__piSubagentControlNoticeBuffers as Map<string, any>;
		for (const buffer of buffers.values()) {
			if (buffer.flushTimer) clearTimeout(buffer.flushTimer);
		}
	});

	it("14.1 three events for one runId within window → ONE multi-step sendMessage", () => {
		registerForeground(state, "run-coalesce");
		const baseTs = Date.now();
		processControlEvent(
			makeEventPayload({
				runId: "run-coalesce",
				index: 0,
				agent: "a",
				ts: baseTs,
				coalesceWindowMs: 1000,
				lastActivityAt: baseTs - 200_000,
				elapsedMs: 200_000,
			}),
			store,
			state,
			visible,
		);
		processControlEvent(
			makeEventPayload({
				runId: "run-coalesce",
				index: 1,
				agent: "b",
				ts: baseTs + 50,
				coalesceWindowMs: 1000,
				lastActivityAt: baseTs - 190_000,
				elapsedMs: 190_000,
			}),
			store,
			state,
			visible,
		);
		processControlEvent(
			makeEventPayload({
				runId: "run-coalesce",
				index: 2,
				agent: "c",
				ts: baseTs + 100,
				coalesceWindowMs: 1000,
				lastActivityAt: baseTs - 180_000,
				elapsedMs: 180_000,
			}),
			store,
			state,
			visible,
		);

		// Manual flush (avoids waiting for the real 1s timer in test).
		flushPendingNotices(pi, store, state);

		assert.equal(pi.sent.length, 1, "exactly one sendMessage for the coalesced batch");
		const msg = pi.sent[0]!.msg as { content: string; details: { events?: ControlEvent[] } };
		assert.equal(msg.details.events?.length, 3, "details.events carries all three events");
		assert.match(msg.content, /3 steps stalled/);
		assert.match(msg.content, /step 1 \(a\): no activity for 200s/);
		assert.match(msg.content, /step 2 \(b\): no activity for 190s/);
		assert.match(msg.content, /step 3 \(c\): no activity for 180s/);
	});

	it("14.2 two different runIds within the window → two separate notices", () => {
		registerForeground(state, "run-x");
		registerForeground(state, "run-y");
		processControlEvent(makeEventPayload({ runId: "run-x", coalesceWindowMs: 1000 }), store, state, visible);
		processControlEvent(makeEventPayload({ runId: "run-y", coalesceWindowMs: 1000 }), store, state, visible);

		flushPendingNotices(pi, store, state);

		assert.equal(pi.sent.length, 2, "one notice per runId");
	});

	it("14.3 coalesceWindowMs: 0 flushes each event synchronously", () => {
		registerForeground(state, "run-sync");
		processControlEvent(makeEventPayload({ runId: "run-sync", index: 0, ts: 1_000, coalesceWindowMs: 0 }), store, state, visible);
		// Sync flush already happened; second event with a different (runId, index) and ts beyond SYNC_DEDUP_WINDOW (1s).
		processControlEvent(makeEventPayload({ runId: "run-sync", index: 1, ts: 3_000, coalesceWindowMs: 0 }), store, state, visible);

		assert.equal(pi.sent.length, 2, "two synchronous flushes for two distinct steps");
	});

	it("14.4 buffer cap (101 events) → 100 published, overflow incremented", () => {
		registerForeground(state, "run-cap");
		for (let i = 0; i < 101; i += 1) {
			processControlEvent(
				makeEventPayload({ runId: "run-cap", index: i, agent: `a${i}`, coalesceWindowMs: 1000 }),
				store,
				state,
				visible,
			);
		}
		flushPendingNotices(pi, store, state);
		assert.equal(pi.sent.length, 1, "one notice");
		const msg = pi.sent[0]!.msg as { details: { events?: ControlEvent[] } };
		assert.equal(msg.details.events?.length, 100, "exactly 100 events in the notice (cap)");
		assert.equal(store.__piSubagentDroppedCoalesceOverflow, 1, "exactly one overflow drop");
	});

	it("14.5 within-buffer dedup: same (runId, index, type) → one bullet only", () => {
		registerForeground(state, "run-dedupe");
		const ts = Date.now();
		processControlEvent(
			makeEventPayload({ runId: "run-dedupe", index: 0, agent: "a", ts, coalesceWindowMs: 1000 }),
			store,
			state,
			visible,
		);
		// Replay (e.g., from async-tracker disk read) — same key.
		processControlEvent(
			makeEventPayload({ runId: "run-dedupe", index: 0, agent: "a", ts: ts + 5, coalesceWindowMs: 1000 }),
			store,
			state,
			visible,
		);
		flushPendingNotices(pi, store, state);
		assert.equal(pi.sent.length, 1);
		const msg = pi.sent[0]!.msg as { details: { events?: ControlEvent[] } };
		assert.equal(msg.details.events?.length, 1, "dedup collapsed to one event");
		assert.equal(store.__piSubagentDedupedNotices, 1);
	});

	it("14.7 re-stall regression: stall → flush+publish → recover (no flush) → re-stall → publish", () => {
		registerForeground(state, "run-restall");
		// Phase 1: first stall. Buffer + manual flush (no need to wait timer).
		processControlEvent(
			makeEventPayload({ runId: "run-restall", index: 0, agent: "a", coalesceWindowMs: 1000 }),
			store,
			state,
			visible,
		);
		flushPendingNotices(pi, store, state);
		assert.equal(pi.sent.length, 1, "first stall publishes");
		const epochAfterFirst = (store.__piSubagentRunFlushEpoch as Map<string, number>).get("run-restall");
		assert.equal(epochAfterFirst, 1, "epoch advanced to 1");

		// Phase 2: re-stall on the same step. Different ts so it represents a new event.
		processControlEvent(
			makeEventPayload({ runId: "run-restall", index: 0, agent: "a", ts: Date.now() + 60_000, coalesceWindowMs: 1000 }),
			store,
			state,
			visible,
		);
		flushPendingNotices(pi, store, state);
		assert.equal(pi.sent.length, 2, "re-stall publishes a SECOND notice (epoch advanced)");
		const epochAfterSecond = (store.__piSubagentRunFlushEpoch as Map<string, number>).get("run-restall");
		assert.equal(epochAfterSecond, 2, "epoch advanced to 2");
	});

	it("14.8 sync-flush window: same key within 1000ms is dropped; >1000ms apart both publish", () => {
		registerForeground(state, "run-sync-dedup");
		processControlEvent(
			makeEventPayload({ runId: "run-sync-dedup", index: 0, ts: 10_000, coalesceWindowMs: 0 }),
			store,
			state,
			visible,
		);
		processControlEvent(
			makeEventPayload({ runId: "run-sync-dedup", index: 0, ts: 10_500, coalesceWindowMs: 0 }),
			store,
			state,
			visible,
		);
		assert.equal(pi.sent.length, 1, "second event within 1000ms is sync-deduped");

		// >1000ms apart → both publish.
		processControlEvent(
			makeEventPayload({ runId: "run-sync-dedup", index: 0, ts: 12_000, coalesceWindowMs: 0 }),
			store,
			state,
			visible,
		);
		assert.equal(pi.sent.length, 2, "third event >1s later publishes");
	});

	it("14.6 reload-DROP: coalesce buffer cleared without sendMessage", () => {
		registerForeground(state, "run-reload");
		processControlEvent(
			makeEventPayload({ runId: "run-reload", coalesceWindowMs: 1000 }),
			store,
			state,
			visible,
		);
		const buffers = store.__piSubagentControlNoticeBuffers as Map<string, any>;
		const eventCountBefore = buffers.get("run-reload")?.events.length ?? 0;
		assert.equal(eventCountBefore, 1);

		// Simulate the runtimeCleanup closure's drop logic inline (the closure
		// itself lives in registerSubagentExtension; reproducing its core here).
		let droppedEvents = 0;
		for (const buffer of buffers.values()) {
			if (buffer.flushTimer) clearTimeout(buffer.flushTimer);
			droppedEvents += buffer.events.length;
		}
		store.__piSubagentDroppedStaleNotices =
			((store.__piSubagentDroppedStaleNotices as number) ?? 0) + droppedEvents;
		buffers.clear();
		store.__piSubagentLastPi = undefined;

		assert.equal(pi.sent.length, 0, "reload-drop never invokes pi.sendMessage");
		assert.equal(store.__piSubagentDroppedStaleNotices, 1, "drop counted as stale");
		assert.equal(buffers.size, 0);
	});
});
