/**
 * Run liveness classification for the control-notice gate.
 *
 * classifyRunForNotice is the canonical gate used at all five bus-emit
 * sites and at flush time in the receiver. It does NOT consult
 * globalStore / recentlyTerminalRuns (Decision 1, 4b in design.md) —
 * the recently-terminal map exists solely for status-lookup consumers.
 */

import type { SubagentState } from "./types.ts";

// Module-scope alias set by setLivenessGlobals. Not used by the
// classifier itself (kept for future helpers in this module that may
// need globalStore, e.g. recording helpers called from executor).
let _globalStore: Record<string, unknown> | undefined;

/**
 * Store the globalStore alias for use by helpers in this module.
 * Called once from registerSubagentExtension before event handlers are
 * installed.
 */
export function setLivenessGlobals(globalStore: Record<string, unknown>): void {
	_globalStore = globalStore;
}

/**
 * Classify a run as "live" or "stale" for the purposes of notice delivery.
 *
 * Live iff:
 *   - state.foregroundControls.has(runId), OR
 *   - state.asyncJobs.get(runId)?.status is "queued" or "running"
 *
 * Everything else — including paused, complete, failed, and unknown ids —
 * is "stale". Recently-terminal entries are NOT consulted (Decision 1).
 *
 * "paused" is stale because the current async tracker schedules cleanup
 * for paused runs and there is no resume API. If paused-as-resumable
 * lifecycle lands later, revisit this classifier.
 */
export function classifyRunForNotice(
	state: SubagentState,
	runId: string,
): "live" | "stale" {
	// Defensive against partial state shapes used in some legacy tests
	// (createState() helpers that omit foregroundControls/asyncJobs).
	const foreground = state?.foregroundControls;
	if (foreground && typeof foreground.has === "function" && foreground.has(runId)) {
		return "live";
	}

	const asyncJobs = state?.asyncJobs;
	const job = asyncJobs && typeof asyncJobs.get === "function" ? asyncJobs.get(runId) : undefined;
	if (job !== undefined && (job.status === "queued" || job.status === "running")) {
		return "live";
	}

	return "stale";
}

// Expose the alias getter for tests / future module-internal helpers.
export function getLivenessGlobalStore(): Record<string, unknown> | undefined {
	return _globalStore;
}
