/**
 * Shared helpers for foreground-control lookup and activity formatting.
 *
 * Originally lived as private helpers in `subagent-executor.ts`; relocated
 * to this module so `run-status.ts` can reuse them for the `action:"status"`
 * lookup path (add-foreground-run-status-lookup change).
 *
 * Avoiding the circular import that exporting from `subagent-executor.ts`
 * would have caused (run-status.ts ↔ subagent-executor.ts).
 */

import type { SubagentState } from "./types.ts";

export type ForegroundControl =
	SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;

/**
 * Resolve a foreground-control entry for a runId.
 *
 * If `runId` is undefined, applies the no-id three-tier fallback:
 *   Tier 1: state.lastForegroundControlId (if present in foregroundControls)
 *   Tier 2: newest entry by updatedAt
 *   Tier 3: undefined (caller falls through to aggregator path)
 */
export function getForegroundControl(
	state: SubagentState,
	runId: string | undefined,
): ForegroundControl | undefined {
	if (runId) return state.foregroundControls.get(runId);
	if (state.lastForegroundControlId) {
		const latest = state.foregroundControls.get(state.lastForegroundControlId);
		if (latest) return latest;
	}
	let newest: ForegroundControl | undefined;
	for (const control of state.foregroundControls.values()) {
		if (!newest || control.updatedAt > newest.updatedAt) newest = control;
	}
	return newest;
}

/**
 * Format the activity-state line for a foreground control. Returns
 * `undefined` when there is nothing meaningful to report.
 */
export function formatForegroundActivity(control: ForegroundControl): string | undefined {
	if (control.currentTool && control.currentToolStartedAt) {
		return `tool ${control.currentTool} for ${Math.floor(
			Math.max(0, Date.now() - control.currentToolStartedAt) / 1000,
		)}s`;
	}
	if (!control.lastActivityAt) {
		return control.currentActivityState === "needs_attention" ? "needs attention" : undefined;
	}
	const seconds = Math.floor(Math.max(0, Date.now() - control.lastActivityAt) / 1000);
	return control.currentActivityState === "needs_attention"
		? `no activity for ${seconds}s`
		: `active ${seconds}s ago`;
}
