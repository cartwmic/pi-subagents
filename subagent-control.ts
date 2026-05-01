import {
	type ActivityState,
	type ControlConfig,
	type ControlEvent,
	type ControlEventType,
	type ControlNotificationChannel,
	type ResolvedControlConfig,
} from "./types.ts";

const CONTROL_EVENT_TYPES: ControlEventType[] = ["needs_attention"];
const CONTROL_NOTIFICATION_CHANNELS: ControlNotificationChannel[] = ["event", "async", "intercom"];
const DEFAULT_NOTIFY_ON: ControlEventType[] = ["needs_attention"];

/** Default coalesce window for receiver-side multi-step coalescing. */
export const DEFAULT_COALESCE_WINDOW_MS = 1000;

export const DEFAULT_CONTROL_CONFIG: ResolvedControlConfig = {
	enabled: true,
	// BREAKING-IN-DEFAULT (improve-control-notice-tuning): bumped 60s → 180s
	// to accommodate normal long-thinking turns. Override via
	// `control.needsAttentionAfterMs` to restore prior behavior.
	needsAttentionAfterMs: 180_000,
	notifyOn: DEFAULT_NOTIFY_ON,
	notifyChannels: CONTROL_NOTIFICATION_CHANNELS,
	coalesceWindowMs: DEFAULT_COALESCE_WINDOW_MS,
};

function parsePositiveInt(value: unknown): number | undefined {
	if (typeof value !== "number") return undefined;
	if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) return undefined;
	return value;
}

/**
 * Like `parsePositiveInt` but accepts `0`. Used for `coalesceWindowMs` where
 * `0` is a valid "disable coalescing" sentinel. Negative / non-integer / NaN
 * still falls back to the default.
 */
function parseNonNegativeInt(value: unknown): number | undefined {
	if (typeof value !== "number") return undefined;
	if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) return undefined;
	return value;
}

function parseControlList<T extends string>(value: unknown, allowed: readonly T[]): T[] | undefined {
	if (!Array.isArray(value)) return undefined;
	if (value.length === 0) return [];
	const allowedSet = new Set(allowed);
	const parsed = value.filter((entry): entry is T => typeof entry === "string" && allowedSet.has(entry as T));
	return parsed.length > 0 ? Array.from(new Set(parsed)) : undefined;
}

export function resolveControlConfig(
	globalConfig?: ControlConfig,
	override?: ControlConfig,
): ResolvedControlConfig {
	const enabled = override?.enabled ?? globalConfig?.enabled ?? DEFAULT_CONTROL_CONFIG.enabled;
	const needsAttentionAfterMs = parsePositiveInt(override?.needsAttentionAfterMs)
		?? parsePositiveInt(globalConfig?.needsAttentionAfterMs)
		?? DEFAULT_CONTROL_CONFIG.needsAttentionAfterMs;
	const notifyOn = parseControlList(override?.notifyOn, CONTROL_EVENT_TYPES)
		?? parseControlList(globalConfig?.notifyOn, CONTROL_EVENT_TYPES)
		?? DEFAULT_CONTROL_CONFIG.notifyOn;
	const notifyChannels = parseControlList(override?.notifyChannels, CONTROL_NOTIFICATION_CHANNELS)
		?? parseControlList(globalConfig?.notifyChannels, CONTROL_NOTIFICATION_CHANNELS)
		?? DEFAULT_CONTROL_CONFIG.notifyChannels;
	const coalesceWindowMs = parseNonNegativeInt(override?.coalesceWindowMs)
		?? parseNonNegativeInt(globalConfig?.coalesceWindowMs)
		?? DEFAULT_CONTROL_CONFIG.coalesceWindowMs;
	return {
		enabled,
		needsAttentionAfterMs,
		notifyOn: [...notifyOn],
		notifyChannels: [...notifyChannels],
		coalesceWindowMs,
	};
}

export function deriveActivityState(input: {
	config: ResolvedControlConfig;
	startedAt: number;
	lastActivityAt?: number;
	now?: number;
}): ActivityState | undefined {
	if (!input.config.enabled) return undefined;
	const now = input.now ?? Date.now();
	const lastActivity = input.lastActivityAt ?? input.startedAt;
	const ageMs = Math.max(0, now - lastActivity);
	return ageMs > input.config.needsAttentionAfterMs ? "needs_attention" : undefined;
}

export function shouldEmitControlEvent(
	config: ResolvedControlConfig,
	from: ActivityState | undefined,
	to: ActivityState | undefined,
): boolean {
	return config.enabled && from !== to && to === "needs_attention";
}

export function buildControlEvent(input: {
	from?: ActivityState;
	to: ActivityState;
	runId: string;
	agent: string;
	index?: number;
	ts?: number;
	lastActivityAt?: number;
}): ControlEvent {
	const ts = input.ts ?? Date.now();
	const elapsedMs = input.lastActivityAt ? Math.max(0, ts - input.lastActivityAt) : undefined;
	const elapsedSeconds = elapsedMs !== undefined ? Math.floor(elapsedMs / 1000) : undefined;
	const message = elapsedSeconds !== undefined
		? `${input.agent} needs attention (no observed activity for ${elapsedSeconds}s)`
		: `${input.agent} needs attention`;
	return {
		type: "needs_attention",
		from: input.from,
		to: input.to,
		ts,
		runId: input.runId,
		agent: input.agent,
		index: input.index,
		message,
		lastActivityAt: input.lastActivityAt,
		elapsedMs,
	};
}

export function shouldNotifyControlEvent(config: ResolvedControlConfig, event: ControlEvent): boolean {
	return config.enabled && config.notifyOn.includes(event.type);
}

export function controlNotificationKey(event: ControlEvent, childIntercomTarget?: string): string {
	return controlNotificationKeyFor(event.runId, event.index, event.type, childIntercomTarget);
}

/**
 * Same key shape as `controlNotificationKey` but takes primitives directly.
 *
 * Used by the emitter-side dedup recovery clear in `execution.ts` and
 * `subagent-runner.ts` (improve-control-notice-tuning Section 9b) where
 * constructing a synthetic `ControlEvent` just to pass to
 * `controlNotificationKey` would require fake/cast values for the
 * required-but-irrelevant fields (`to`, `ts`, `agent`, `message`).
 */
export function controlNotificationKeyFor(
	runId: string,
	index: number | undefined,
	type: ControlEventType,
	childIntercomTarget?: string,
): string {
	const childKey = childIntercomTarget ?? (index !== undefined ? `${runId}:${index}` : runId);
	return `${childKey}:${type}`;
}

export function claimControlNotification(config: ResolvedControlConfig, event: ControlEvent, seenKeys: Set<string>, childIntercomTarget?: string): boolean {
	if (!shouldNotifyControlEvent(config, event)) return false;
	const key = controlNotificationKey(event, childIntercomTarget);
	if (seenKeys.has(key)) return false;
	seenKeys.add(key);
	return true;
}

export function formatControlNoticeMessage(event: ControlEvent, childIntercomTarget?: string): string {
	const runTarget = event.runId;
	const nudgeCommand = childIntercomTarget
		? `intercom({ action: "send", to: "${childIntercomTarget}", message: "What are you blocked on? Reply with the smallest next step or ask for a decision." })`
		: undefined;
	return [
		`Subagent needs attention: ${event.agent}`,
		`Run: ${runTarget}${event.index !== undefined ? ` step ${event.index + 1}` : ""}`,
		`Signal: ${event.message}`,
		"Hint: Inspect status first unless the run is clearly blocked.",
		childIntercomTarget
			? `Nudge: ${nudgeCommand}`
			: "Action: this run has no intercom; if it's stuck, use Interrupt above.",
		`Status: subagent({ action: "status", id: "${runTarget}" })`,
		`Interrupt: subagent({ action: "interrupt", id: "${runTarget}" })`,
	].join("\n");
}

/**
 * Format a multi-step coalesced control notice. Used when more than one
 * `needs_attention` event for the same runId arrives within the coalesce
 * window. For N === 1 callers should still prefer
 * `formatControlNoticeMessage` directly (this function delegates when given
 * a single-event input for safety).
 *
 * @param thresholdMs The configured `needsAttentionAfterMs` at the time the
 *   coalesce buffer was opened. Rendered as the ">~Ns no activity" cutoff.
 */
export function formatCoalescedControlNoticeMessage(
	events: ControlEvent[],
	childIntercomTargets: Map<number, string>,
	thresholdMs: number,
): string {
	if (events.length === 0) return "";
	if (events.length === 1) {
		const single = events[0]!;
		return formatControlNoticeMessage(
			single,
			childIntercomTargets.get(single.index ?? 0),
		);
	}
	const runId = events[0]!.runId;
	const thresholdSeconds = Math.floor((thresholdMs ?? DEFAULT_CONTROL_CONFIG.needsAttentionAfterMs) / 1000);
	const now = Date.now();
	const lines: string[] = [];
	lines.push(`Subagent needs attention: run ${runId}`);
	lines.push(`${events.length} steps stalled (>~${thresholdSeconds}s no activity):`);
	for (const event of events) {
		const stepLabel = (event.index ?? 0) + 1;
		const elapsedSeconds = event.elapsedMs !== undefined
			? Math.floor(event.elapsedMs / 1000)
			: Math.floor(Math.max(0, now - event.ts) / 1000);
		lines.push(`  - step ${stepLabel} (${event.agent}): no activity for ${elapsedSeconds}s`);
	}
	lines.push(`Status: subagent({ action: "status", id: "${runId}" })`);
	lines.push(`Interrupt: subagent({ action: "interrupt", id: "${runId}" })`);
	let anyMissingIntercom = false;
	for (const event of events) {
		const target = childIntercomTargets.get(event.index ?? 0);
		if (target) {
			const stepLabel = (event.index ?? 0) + 1;
			lines.push(
				`  step ${stepLabel}: Nudge: intercom({ action: "send", to: "${target}", message: "What are you blocked on?" })`,
			);
		} else {
			anyMissingIntercom = true;
		}
	}
	if (anyMissingIntercom) {
		lines.push("Action: this run has no intercom; if it's stuck, use Interrupt above.");
	}
	return lines.join("\n");
}

export function formatControlIntercomMessage(event: ControlEvent, childIntercomTarget?: string): string {
	return [
		"subagent needs attention",
		"",
		`${event.agent} needs attention in run ${event.runId}.`,
		"",
		formatControlNoticeMessage(event, childIntercomTarget),
	].join("\n");
}
