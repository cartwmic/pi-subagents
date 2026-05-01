import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	RECENT_TERMINAL_MAX_ENTRIES,
	RECENT_TERMINAL_TTL_MS,
	recordTerminalRun,
	sweepRecentTerminalRuns,
	type RecentTerminalEntry,
} from "../../recent-terminal.ts";

const STORE_KEY = "__piSubagentRecentlyTerminalRuns";

function freshStore(): Record<string, unknown> {
	return {};
}

function getMap(store: Record<string, unknown>): Map<string, RecentTerminalEntry> {
	return store[STORE_KEY] as Map<string, RecentTerminalEntry>;
}

describe("recordTerminalRun", () => {
	it("inserts an entry with correct shape", () => {
		const store = freshStore();
		const before = Date.now();
		recordTerminalRun(store, "run-1", "succeeded");
		const after = Date.now();

		const map = getMap(store);
		assert.ok(map instanceof Map, "map should be initialized");
		assert.equal(map.size, 1);

		const entry = map.get("run-1");
		assert.ok(entry !== undefined);
		assert.equal(entry.terminalState, "succeeded");
		assert.ok(entry.terminatedAt >= before && entry.terminatedAt <= after, "terminatedAt should be current timestamp");
	});

	it("stores 'failed' and 'interrupted' states", () => {
		const store = freshStore();
		recordTerminalRun(store, "run-f", "failed");
		recordTerminalRun(store, "run-i", "interrupted");

		assert.equal(getMap(store).get("run-f")?.terminalState, "failed");
		assert.equal(getMap(store).get("run-i")?.terminalState, "interrupted");
	});

	it("first-write-wins: second call does not modify the entry", () => {
		const store = freshStore();
		recordTerminalRun(store, "run-1", "succeeded");
		const first = getMap(store).get("run-1")!;
		const originalAt = first.terminatedAt;
		const originalState = first.terminalState;

		// Wait 1ms to ensure Date.now() would differ if a write occurred.
		// (We patch nothing — just assert the values don't change.)
		recordTerminalRun(store, "run-1", "failed");

		const entry = getMap(store).get("run-1")!;
		assert.equal(entry.terminalState, originalState, "terminalState must not change");
		assert.equal(entry.terminatedAt, originalAt, "terminatedAt must not change");
		assert.equal(getMap(store).size, 1);
	});

	it("cap eviction: inserting the 1001st entry evicts the oldest terminatedAt", () => {
		const store = freshStore();

		// Insert RECENT_TERMINAL_MAX_ENTRIES entries with increasing timestamps.
		// We use the store's map directly so we can control terminatedAt precisely.
		const map = new Map<string, RecentTerminalEntry>();
		store[STORE_KEY] = map;

		const BASE_TIME = 1_000_000;
		for (let i = 0; i < RECENT_TERMINAL_MAX_ENTRIES; i++) {
			map.set(`run-${i}`, { terminatedAt: BASE_TIME + i, terminalState: "succeeded" });
		}
		assert.equal(map.size, RECENT_TERMINAL_MAX_ENTRIES);

		// The oldest entry is run-0 (terminatedAt = BASE_TIME).
		// Insert run-extra which will push size to 1001 and trigger eviction.
		recordTerminalRun(store, "run-extra", "failed");

		assert.equal(map.size, RECENT_TERMINAL_MAX_ENTRIES, "size should return to 1000 after eviction");
		assert.ok(!map.has("run-0"), "oldest entry (run-0) should have been evicted");
		assert.ok(map.has("run-extra"), "new entry should be present");
	});

	it("cap eviction: keeps all other entries intact after eviction", () => {
		const store = freshStore();
		const map = new Map<string, RecentTerminalEntry>();
		store[STORE_KEY] = map;

		for (let i = 0; i < RECENT_TERMINAL_MAX_ENTRIES; i++) {
			map.set(`run-${i}`, { terminatedAt: 1_000 + i, terminalState: "succeeded" });
		}

		recordTerminalRun(store, "run-overflow", "interrupted");

		// run-0 is gone; run-1 through run-999 and run-overflow remain.
		assert.ok(!map.has("run-0"));
		assert.ok(map.has("run-1"));
		assert.ok(map.has(`run-${RECENT_TERMINAL_MAX_ENTRIES - 1}`));
		assert.ok(map.has("run-overflow"));
	});
});

describe("sweepRecentTerminalRuns", () => {
	it("is idempotent on an empty (non-initialized) store", () => {
		const store = freshStore();
		// Should not throw even before any map is initialized.
		assert.doesNotThrow(() => sweepRecentTerminalRuns(store, Date.now()));
		// After sweep, map is initialized and empty.
		const map = getMap(store);
		assert.equal(map.size, 0);
	});

	it("is idempotent on an already-empty map", () => {
		const store = freshStore();
		recordTerminalRun(store, "run-1", "succeeded");
		// Sweep far into the future to clear it.
		sweepRecentTerminalRuns(store, Date.now() + RECENT_TERMINAL_TTL_MS + 1);
		assert.equal(getMap(store).size, 0);
		// Second sweep on empty map should not throw.
		assert.doesNotThrow(() => sweepRecentTerminalRuns(store, Date.now()));
	});

	it("TTL boundary: entry just inside TTL survives", () => {
		const store = freshStore();
		const map = new Map<string, RecentTerminalEntry>();
		store[STORE_KEY] = map;

		const recordedAt = 1_000_000;
		map.set("run-alive", { terminatedAt: recordedAt, terminalState: "succeeded" });

		// now = recordedAt + TTL - 1  →  age = TTL - 1  →  should survive
		const now = recordedAt + RECENT_TERMINAL_TTL_MS - 1;
		sweepRecentTerminalRuns(store, now);

		assert.ok(map.has("run-alive"), "entry within TTL should survive sweep");
	});

	it("TTL boundary: entry exactly at TTL threshold is removed", () => {
		const store = freshStore();
		const map = new Map<string, RecentTerminalEntry>();
		store[STORE_KEY] = map;

		const recordedAt = 1_000_000;
		map.set("run-expired", { terminatedAt: recordedAt, terminalState: "succeeded" });

		// now = recordedAt + TTL  →  age = TTL  →  entry.terminatedAt <= cutoff
		const now = recordedAt + RECENT_TERMINAL_TTL_MS;
		sweepRecentTerminalRuns(store, now);

		assert.ok(!map.has("run-expired"), "entry at exact TTL boundary should be removed");
	});

	it("TTL boundary: entry just outside TTL is removed", () => {
		const store = freshStore();
		const map = new Map<string, RecentTerminalEntry>();
		store[STORE_KEY] = map;

		const recordedAt = 1_000_000;
		map.set("run-old", { terminatedAt: recordedAt, terminalState: "failed" });

		const now = recordedAt + RECENT_TERMINAL_TTL_MS + 1;
		sweepRecentTerminalRuns(store, now);

		assert.ok(!map.has("run-old"), "entry past TTL should be swept");
	});

	it("sweeps only expired entries, preserving live ones", () => {
		const store = freshStore();
		const map = new Map<string, RecentTerminalEntry>();
		store[STORE_KEY] = map;

		const now = 2_000_000;
		map.set("old", { terminatedAt: now - RECENT_TERMINAL_TTL_MS - 500, terminalState: "succeeded" });
		map.set("fresh", { terminatedAt: now - 1000, terminalState: "failed" });

		sweepRecentTerminalRuns(store, now);

		assert.ok(!map.has("old"), "old entry should be removed");
		assert.ok(map.has("fresh"), "fresh entry should remain");
		assert.equal(map.size, 1);
	});
});
