/**
 * recently-terminal run tracking for the control-notice liveness gate.
 *
 * Stores a bounded, TTL-expiring map in globalStore so entries survive
 * ctx.reload() patterns. Consumed by add-foreground-run-status-lookup
 * (not by classifyRunForNotice — Decision 1 in design.md).
 */

export const RECENT_TERMINAL_TTL_MS = 30_000;
export const RECENT_TERMINAL_MAX_ENTRIES = 1000;

export interface RecentTerminalEntry {
	terminatedAt: number;
	terminalState: "succeeded" | "failed" | "interrupted";
}

const STORE_KEY = "__piSubagentRecentlyTerminalRuns";

function getMap(globalStore: Record<string, unknown>): Map<string, RecentTerminalEntry> {
	const existing = globalStore[STORE_KEY];
	if (existing instanceof Map) return existing as Map<string, RecentTerminalEntry>;
	const map = new Map<string, RecentTerminalEntry>();
	globalStore[STORE_KEY] = map;
	return map;
}

/**
 * Record that a run has reached a terminal state.
 *
 * First-write-wins: if the entry already exists, returns without modifying.
 * After insert, if size > RECENT_TERMINAL_MAX_ENTRIES, evicts the entry
 * with the oldest terminatedAt.
 */
export function recordTerminalRun(
	globalStore: Record<string, unknown>,
	runId: string,
	terminalState: "succeeded" | "failed" | "interrupted",
): void {
	const map = getMap(globalStore);
	if (map.has(runId)) return;

	map.set(runId, { terminatedAt: Date.now(), terminalState });

	if (map.size > RECENT_TERMINAL_MAX_ENTRIES) {
		// Evict the entry with the oldest terminatedAt.
		let oldestKey: string | undefined;
		let oldestAt = Infinity;
		for (const [key, entry] of map) {
			if (entry.terminatedAt < oldestAt) {
				oldestAt = entry.terminatedAt;
				oldestKey = key;
			}
		}
		if (oldestKey !== undefined) map.delete(oldestKey);
	}
}

/**
 * Remove entries whose terminatedAt is older than RECENT_TERMINAL_TTL_MS.
 *
 * @param now - Override for current time (useful in tests).
 */
export function sweepRecentTerminalRuns(
	globalStore: Record<string, unknown>,
	now?: number,
): void {
	const map = getMap(globalStore);
	const cutoff = (now ?? Date.now()) - RECENT_TERMINAL_TTL_MS;
	for (const [key, entry] of map) {
		if (entry.terminatedAt <= cutoff) map.delete(key);
	}
}
