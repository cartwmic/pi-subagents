/**
 * Child lifecycle projection: when the observed child session events mean
 * the run is settling and the observer may start (or must cancel) its final
 * drain window.
 */
export type ChildLifecycleAction = "start-drain" | "cancel-drain" | "none";

export interface ChildLifecycleState {
	compactionRetryActive: boolean;
	compactionActive?: boolean;
	terminalObserved?: boolean;
}

export function projectChildLifecycle(event: { type?: string; willRetry?: unknown }, terminalAssistantStop = false, state?: ChildLifecycleState): ChildLifecycleAction {
	if (event.type === "compaction_start") {
		if (state) state.compactionActive = true;
		return "cancel-drain";
	}
	if (event.type === "compaction_end") {
		if (state) {
			state.compactionActive = false;
			state.compactionRetryActive = event.willRetry === true;
		}
		if (event.willRetry === true) return "cancel-drain";
		return state?.terminalObserved ? "start-drain" : "none";
	}
	if (event.type === "agent_start" || event.type === "auto_retry_start" || event.type === "turn_start") {
		if (state) {
			state.compactionRetryActive = false;
			state.terminalObserved = false;
		}
		return "cancel-drain";
	}
	if (event.type === "agent_end") {
		if (event.willRetry !== true && state) state.compactionRetryActive = false;
		return "cancel-drain";
	}
	if (event.type === "agent_settled" || terminalAssistantStop) {
		if (state?.compactionRetryActive) return "none";
		if (state) state.terminalObserved = true;
		return state?.compactionActive ? "none" : "start-drain";
	}
	return "none";
}
