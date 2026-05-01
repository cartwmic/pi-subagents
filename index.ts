/**
 * Subagent Tool
 *
 * Full-featured subagent with sync and async modes.
 * - Sync (default): Streams output, renders markdown, tracks usage
 * - Async: Background execution, emits events when done
 *
 * Modes: single (agent + task), parallel (tasks[]), chain (chain[] with {previous})
 * Toggle: async parameter (default: false, configurable via config.json)
 *
 * Config file: ~/.pi/agent/extensions/subagent/config.json
 *   { "asyncByDefault": true, "forceTopLevelAsync": true, "maxSubagentDepth": 1, "intercomBridge": { "mode": "always", "instructionFile": "./intercom-bridge.md" }, "worktreeSetupHook": "./scripts/setup-worktree.mjs" }
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Box, Container, Spacer, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@mariozechner/pi-tui";
import { discoverAgents } from "./agents.ts";
import { cleanupAllArtifactDirs, cleanupOldArtifacts, getArtifactsDir } from "./artifacts.ts";
import { cleanupOldChainDirs } from "./settings.ts";
import { renderWidget, renderSubagentResult, stopResultAnimations, stopWidgetAnimation, syncResultAnimation } from "./render.ts";
import { SubagentParams } from "./schemas.ts";
import { createSubagentExecutor } from "./subagent-executor.ts";
import { createAsyncJobTracker } from "./async-job-tracker.ts";
import {
	DEFAULT_CONTROL_CONFIG,
	formatCoalescedControlNoticeMessage,
	formatControlNoticeMessage,
} from "./subagent-control.ts";
import { createResultWatcher } from "./result-watcher.ts";
import { registerSlashCommands } from "./slash-commands.ts";
import { registerPromptTemplateDelegationBridge } from "./prompt-template-bridge.ts";
import { registerSlashSubagentBridge } from "./slash-bridge.ts";
import { clearSlashSnapshots, getSlashRenderableSnapshot, resolveSlashMessageDetails, restoreSlashFinalSnapshots, type SlashMessageDetails } from "./slash-live-state.ts";
import { inspectSubagentStatus } from "./run-status.ts";
import registerSubagentNotify, { type SubagentNotifyDetails } from "./notify.ts";
import { formatDuration, shortenPath } from "./formatters.ts";
import {
	type ControlEvent,
	type Details,
	type ExtensionConfig,
	type SubagentState,
	ASYNC_DIR,
	DEFAULT_ARTIFACT_CONFIG,
	RESULTS_DIR,
	SLASH_RESULT_TYPE,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_CONTROL_EVENT,
	WIDGET_KEY,
} from "./types.ts";
import { classifyRunForNotice, setLivenessGlobals } from "./liveness.ts";
import { sweepRecentTerminalRuns } from "./recent-terminal.ts";

/**
 * Derive subagent session base directory from parent session file.
 * If parent session is ~/.pi/agent/sessions/abc123.jsonl,
 * returns ~/.pi/agent/sessions/abc123/ as the base.
 * Callers add runId to create the actual session root: abc123/{runId}/
 * Falls back to a unique temp directory if no parent session.
 */
function getSubagentSessionRoot(parentSessionFile: string | null): string {
	if (parentSessionFile) {
		const baseName = path.basename(parentSessionFile, ".jsonl");
		const sessionsDir = path.dirname(parentSessionFile);
		return path.join(sessionsDir, baseName);
	}
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-"));
}

function loadConfig(): ExtensionConfig {
	const configPath = path.join(os.homedir(), ".pi", "agent", "extensions", "subagent", "config.json");
	try {
		if (fs.existsSync(configPath)) {
			return JSON.parse(fs.readFileSync(configPath, "utf-8")) as ExtensionConfig;
		}
	} catch (error) {
		console.error(`Failed to load subagent config from '${configPath}':`, error);
	}
	return {};
}

function expandTilde(p: string): string {
	return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * Create a directory and verify it is actually accessible.
 * On Windows with Azure AD/Entra ID, directories created shortly after
 * wake-from-sleep can end up with broken NTFS ACLs (null DACL) when the
 * cloud SID cannot be resolved without network connectivity. This leaves
 * the directory completely inaccessible to the creating user.
 */
function ensureAccessibleDir(dirPath: string): void {
	fs.mkdirSync(dirPath, { recursive: true });
	try {
		fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
	} catch {
		try {
			fs.rmSync(dirPath, { recursive: true, force: true });
		} catch {
			// Best effort: retry mkdir/access even if cleanup fails.
		}
		fs.mkdirSync(dirPath, { recursive: true });
		fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
	}
}

function isSlashResultRunning(result: { details?: Details }): boolean {
	return result.details?.progress?.some((entry) => entry.status === "running")
		|| result.details?.results.some((entry) => entry.progress?.status === "running")
		|| false;
}

function isSlashResultError(result: { details?: Details }): boolean {
	return result.details?.results.some((entry) => entry.exitCode !== 0 && entry.progress?.status !== "running") || false;
}

function rebuildSlashResultContainer(
	container: Container,
	result: AgentToolResult<Details>,
	options: { expanded: boolean },
	theme: ExtensionContext["ui"]["theme"],
): void {
	container.clear();
	container.addChild(new Spacer(1));
	const boxTheme = isSlashResultRunning(result) ? "toolPendingBg" : isSlashResultError(result) ? "toolErrorBg" : "toolSuccessBg";
	const box = new Box(1, 1, (text: string) => theme.bg(boxTheme, text));
	box.addChild(renderSubagentResult(result, options, theme));
	container.addChild(box);
}

function createSlashResultComponent(
	details: SlashMessageDetails,
	options: { expanded: boolean },
	theme: ExtensionContext["ui"]["theme"],
	requestRender: () => void,
): Container {
	const container = new Container();
	const animationState: { subagentResultAnimationTimer?: ReturnType<typeof setInterval> } = {};
	let lastVersion = -1;
	container.render = (width: number): string[] => {
		const snapshot = getSlashRenderableSnapshot(details);
		syncResultAnimation(snapshot.result, { state: animationState, invalidate: requestRender });
		if (snapshot.version !== lastVersion || isSlashResultRunning(snapshot.result)) {
			lastVersion = snapshot.version;
			rebuildSlashResultContainer(container, snapshot.result, options, theme);
		}
		return Container.prototype.render.call(container, width);
	};
	return container;
}

const SUBAGENT_CONTROL_MESSAGE_TYPE = "subagent_control_notice";

interface SubagentControlMessageDetails {
	event: ControlEvent;
	source?: "foreground" | "async";
	asyncDir?: string;
	childIntercomTarget?: string;
	noticeText?: string;
	/**
	 * Multi-step coalesced events for the same runId. Populated at flush time
	 * by the receiver-side coalesce buffer when more than one notice for the
	 * same runId arrived within `coalesceWindowMs`. The renderer reads this
	 * to switch to the run-level header. Optional / additive (single-event
	 * notices leave it undefined).
	 */
	events?: ControlEvent[];
	/** Threshold captured at first event in the coalesce buffer. */
	needsAttentionAfterMs?: number;
	/** Window captured at first event in the coalesce buffer. */
	coalesceWindowMs?: number;
}

function controlNoticeTarget(details: SubagentControlMessageDetails): string | undefined {
	return details.childIntercomTarget;
}

function formatSubagentControlNotice(details: SubagentControlMessageDetails, content?: string): string {
	return details.noticeText ?? content ?? formatControlNoticeMessage(details.event, controlNoticeTarget(details));
}

function parseSubagentNotifyContent(content: string): SubagentNotifyDetails | undefined {
	const lines = content.split("\n");
	const header = lines[0] ?? "";
	const match = header.match(/^Background task (completed|failed|paused): \*\*(.+?)\*\*(?:\s+(\([^)]*\)))?$/);
	if (!match) return undefined;
	const body = lines.slice(2);
	let sessionIndex = -1;
	for (let i = body.length - 1; i >= 1; i--) {
		if (body[i - 1]?.trim() === "" && /^(Session|Session file|Session share error):\s+/.test(body[i]!)) {
			sessionIndex = i;
			break;
		}
	}
	const sessionLine = sessionIndex >= 0 ? body[sessionIndex] : undefined;
	const resultLines = sessionIndex >= 0 ? body.slice(0, sessionIndex) : body;
	const resultPreview = resultLines.join("\n").trim() || "(no output)";
	let sessionLabel: string | undefined;
	let sessionValue: string | undefined;
	if (sessionLine) {
		const separator = sessionLine.indexOf(":");
		sessionLabel = sessionLine.slice(0, separator).toLowerCase();
		sessionValue = sessionLine.slice(separator + 1).trim();
	}
	return {
		agent: match[2]!,
		status: match[1] as SubagentNotifyDetails["status"],
		...(match[3] ? { taskInfo: match[3] } : {}),
		resultPreview,
		...(sessionLabel && sessionValue ? { sessionLabel, sessionValue } : {}),
	};
}

class SubagentControlNoticeComponent implements Component {
	private readonly details: SubagentControlMessageDetails;
	private readonly theme: ExtensionContext["ui"]["theme"];
	constructor(
		details: SubagentControlMessageDetails,
		theme: ExtensionContext["ui"]["theme"],
	) {
		this.details = details;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const eventLabel = this.details.event.type.replaceAll("_", " ");
		if (width < 3) return [truncateToWidth(`Subagent ${eventLabel}`, width)];
		const bodyWidth = Math.max(1, Math.min(width - 2, 68));
		const borderChar = "─";
		// Multi-step coalesced notice: render the run-level header. Single-event
		// notices keep the per-agent header for backward visual compatibility.
		const events = this.details.events;
		const header = events && events.length > 1
			? ` ⚠ Subagent ${eventLabel}: run ${this.details.event.runId} (${events.length} steps) `
			: ` ⚠ Subagent ${eventLabel}: ${this.details.event.agent} `;
		const headerText = truncateToWidth(header, bodyWidth, "");
		const headerPadding = Math.max(0, bodyWidth - visibleWidth(headerText));
		const lines = [this.theme.fg("accent", `╭${headerText}${borderChar.repeat(headerPadding)}╮`)];

		for (const line of wrapTextWithAnsi(formatSubagentControlNotice(this.details), bodyWidth)) {
			const text = truncateToWidth(line, bodyWidth, "");
			const padding = Math.max(0, bodyWidth - visibleWidth(text));
			lines.push(this.theme.fg("accent", `│${text}${" ".repeat(padding)}│`));
		}
		lines.push(this.theme.fg("accent", `╰${borderChar.repeat(bodyWidth)}╯`));
		return lines;
	}
}

// ── globalStore key constants ──────────────────────────────────────────────
const __piSubagentRecentlyTerminalRuns = "__piSubagentRecentlyTerminalRuns";
const __piSubagentDroppedStaleNotices = "__piSubagentDroppedStaleNotices";
const __piSubagentDedupedNotices = "__piSubagentDedupedNotices";
const __piSubagentSweepTimer = "__piSubagentSweepTimer";
const __piSubagentFlushFallbackTimer = "__piSubagentFlushFallbackTimer";
// improve-control-notice-tuning Section 4: per-runId coalesce buffer (subsumes
// change-1's __piSubagentPendingNotices). Keys live alongside change-1's keys
// so reload cleanup can clear both.
const __piSubagentControlNoticeBuffers = "__piSubagentControlNoticeBuffers";
const __piSubagentDroppedCoalesceOverflow = "__piSubagentDroppedCoalesceOverflow";
const __piSubagentSyncFlushDedup = "__piSubagentSyncFlushDedup";
const __piSubagentRunFlushEpoch = "__piSubagentRunFlushEpoch";
const __piSubagentLastPi = "__piSubagentLastPi";
// Key for the dedup set — defined at module level so flushPendingNotices can use it.
export const visibleControlNoticesStoreKey = "__piSubagentVisibleControlNotices";
// ────────────────────────────────────────────────────────────────────────────

/** Coalesce-buffer cap: per-runId events; overflow is counted and dropped. */
const COALESCE_BUFFER_MAX = 100;
/** Sync-flush (coalesceWindowMs===0) dedup window for cross-source same-key. */
const SYNC_DEDUP_WINDOW_MS = 1000;
/** Sync-flush dedup map sweep cadence — evicts entries older than 30s. */
const SYNC_DEDUP_TTL_MS = 30_000;

export interface CoalesceBufferEvent {
	event: ControlEvent;
	noticeText?: string;
	source?: "foreground" | "async";
	asyncDir?: string;
}

export interface CoalesceBufferEntry {
	events: CoalesceBufferEvent[];
	flushTimer?: NodeJS.Timeout;
	openedAt: number;
	needsAttentionAfterMs: number;
	coalesceWindowMs: number;
	childIntercomTargets: Map<number, string>;
	dedupKeys: Set<string>;
}

function getOrInitMap<V>(
	globalStore: Record<string, unknown>,
	key: string,
): Map<string, V> {
	const existing = globalStore[key];
	if (existing instanceof Map) return existing as Map<string, V>;
	const map = new Map<string, V>();
	globalStore[key] = map;
	return map;
}

function resolveCoalesceWindowMsFromPayload(payloadValue: unknown): number {
	if (
		typeof payloadValue === "number" &&
		Number.isFinite(payloadValue) &&
		Number.isInteger(payloadValue) &&
		payloadValue >= 0
	) {
		return payloadValue;
	}
	return DEFAULT_CONTROL_CONFIG.coalesceWindowMs;
}

function resolveNeedsAttentionAfterMsFromPayload(payloadValue: unknown): number {
	if (
		typeof payloadValue === "number" &&
		Number.isFinite(payloadValue) &&
		Number.isInteger(payloadValue) &&
		payloadValue >= 1
	) {
		return payloadValue;
	}
	return DEFAULT_CONTROL_CONFIG.needsAttentionAfterMs;
}

/**
 * Process an incoming SUBAGENT_CONTROL_EVENT into the per-runId coalesce buffer.
 *
 * For `coalesceWindowMs > 0` (default 1000ms), buffers events for the same
 * runId and schedules a single flush via setTimeout. For `coalesceWindowMs === 0`,
 * flushes synchronously and uses a separate cross-source dedup map
 * (SYNC_DEDUP_WINDOW_MS = 1000ms) to absorb the live-bus + async-tracker
 * disk-replay double-emit case.
 *
 * Liveness re-checking happens at flush time (per change-1's contract).
 */
export function processControlEvent(
	payload: unknown,
	globalStore: Record<string, unknown>,
	state: SubagentState,
	_visibleControlNotices: Set<string>,
): void {
	const details = payload as SubagentControlMessageDetails;
	if (!details?.event) return;
	const event = details.event;
	const runId = event.runId;
	const childIntercomTarget = controlNoticeTarget(details);

	const dedupKey = `${runId}:${event.index ?? "none"}:${event.type}`;
	const coalesceWindowMs = resolveCoalesceWindowMsFromPayload(
		(details as { coalesceWindowMs?: unknown }).coalesceWindowMs,
	);

	// coalesceWindowMs === 0: sync-flush path. Cross-source dedup via a
	// time-windowed map separate from per-runId buffer dedupKeys.
	if (coalesceWindowMs === 0) {
		const syncMap = getOrInitMap<number>(globalStore, __piSubagentSyncFlushDedup);
		const lastSeenAt = syncMap.get(dedupKey);
		if (lastSeenAt !== undefined && event.ts - lastSeenAt < SYNC_DEDUP_WINDOW_MS) {
			globalStore[__piSubagentDedupedNotices] =
				((globalStore[__piSubagentDedupedNotices] as number) ?? 0) + 1;
			return;
		}
		syncMap.set(dedupKey, event.ts);
	}

	const buffers = getOrInitMap<CoalesceBufferEntry>(globalStore, __piSubagentControlNoticeBuffers);
	let buffer = buffers.get(runId);
	if (!buffer) {
		buffer = {
			events: [],
			openedAt: Date.now(),
			needsAttentionAfterMs: resolveNeedsAttentionAfterMsFromPayload(
				(details as { needsAttentionAfterMs?: unknown }).needsAttentionAfterMs,
			),
			coalesceWindowMs,
			childIntercomTargets: new Map(),
			dedupKeys: new Set(),
		};
		buffers.set(runId, buffer);
	}

	// Within-buffer dedup (live + async-tracker disk replay produce same key).
	if (buffer.dedupKeys.has(dedupKey)) {
		globalStore[__piSubagentDedupedNotices] =
			((globalStore[__piSubagentDedupedNotices] as number) ?? 0) + 1;
		return;
	}

	if (buffer.events.length >= COALESCE_BUFFER_MAX) {
		globalStore[__piSubagentDroppedCoalesceOverflow] =
			((globalStore[__piSubagentDroppedCoalesceOverflow] as number) ?? 0) + 1;
		return;
	}

	buffer.events.push({
		event,
		noticeText: details.noticeText,
		source: details.source,
		asyncDir: details.asyncDir,
	});
	buffer.dedupKeys.add(dedupKey);
	if (childIntercomTarget !== undefined) {
		buffer.childIntercomTargets.set(event.index ?? 0, childIntercomTarget);
	}

	if (coalesceWindowMs === 0) {
		// Sync flush: skip the timer; flush immediately.
		flushControlNoticeBuffer(runId, globalStore, state);
		return;
	}

	// Schedule a flush on first event for this runId.
	if (!buffer.flushTimer) {
		const timer = setTimeout(() => {
			flushControlNoticeBuffer(runId, globalStore, state);
		}, coalesceWindowMs);
		timer.unref?.();
		buffer.flushTimer = timer;
	}
}

/**
 * Flush a single per-runId coalesce buffer. Reads `pi` from
 * `globalStore.__piSubagentLastPi` (or the override). Re-checks liveness per
 * event and drops stale entries. Uses a per-runId epoch so re-stalls after
 * recovery publish cleanly.
 *
 * Exported for tests; the timer in `processControlEvent` calls this directly.
 */
export function flushControlNoticeBuffer(
	runId: string,
	globalStore: Record<string, unknown>,
	state: SubagentState,
	piOverride?: { sendMessage(msg: unknown, opts: unknown): void },
): void {
	const buffers = globalStore[__piSubagentControlNoticeBuffers] as
		| Map<string, CoalesceBufferEntry>
		| undefined;
	if (!buffers) return;
	const buffer = buffers.get(runId);
	if (!buffer) return;
	buffers.delete(runId);
	if (buffer.flushTimer) clearTimeout(buffer.flushTimer);

	const pi =
		piOverride ??
		(globalStore[__piSubagentLastPi] as { sendMessage(msg: unknown, opts: unknown): void } | undefined);
	if (!pi) return;

	// Per-buffer liveness gate. All events in the buffer share the same runId
	// (the buffer is keyed by runId), so the classification is constant for the
	// whole batch. We still increment droppedStaleNotices by the per-event
	// count so operators get a true rate signal.
	const liveness = classifyRunForNotice(state, runId);
	if (liveness === "stale") {
		globalStore[__piSubagentDroppedStaleNotices] =
			((globalStore[__piSubagentDroppedStaleNotices] as number) ?? 0) +
			buffer.events.length;
		return;
	}
	const liveEvents: CoalesceBufferEvent[] = buffer.events;

	// Per-runId epoch: advances on every successful publish so a re-stall on
	// the same key after recovery still publishes (paired with emitter-side
	// dedup recovery clear in execution.ts / subagent-runner.ts).
	const epochMap = getOrInitMap<number>(globalStore, __piSubagentRunFlushEpoch);
	const epoch = epochMap.get(runId) ?? 0;
	const flushKey = `${runId}:epoch-${epoch}`;
	const visible = globalStore[visibleControlNoticesStoreKey] as Set<string> | undefined;
	if (visible?.has(flushKey)) return; // double-flush guard

	// Build content + details.
	let content: string;
	if (liveEvents.length === 1) {
		const single = liveEvents[0]!;
		content =
			single.noticeText ??
			formatControlNoticeMessage(
				single.event,
				buffer.childIntercomTargets.get(single.event.index ?? 0),
			);
	} else {
		content = formatCoalescedControlNoticeMessage(
			liveEvents.map((entry) => entry.event),
			buffer.childIntercomTargets,
			buffer.needsAttentionAfterMs,
		);
	}

	const firstEntry = liveEvents[0]!;
	const details: SubagentControlMessageDetails = {
		event: firstEntry.event,
		source: firstEntry.source,
		asyncDir: firstEntry.asyncDir,
		childIntercomTarget: buffer.childIntercomTargets.get(firstEntry.event.index ?? 0),
		events: liveEvents.map((entry) => entry.event),
		noticeText: content,
		needsAttentionAfterMs: buffer.needsAttentionAfterMs,
		coalesceWindowMs: buffer.coalesceWindowMs,
	};

	if (visible) visible.add(flushKey);
	epochMap.set(runId, epoch + 1);

	pi.sendMessage(
		{
			customType: SUBAGENT_CONTROL_MESSAGE_TYPE,
			content,
			display: true,
			details,
		},
		{ triggerTurn: true },
	);
}

/**
 * Legacy compatibility shim: flush every pending coalesce buffer.
 *
 * Called by the existing `pi.on("tool_result")` listener and the 5s fallback
 * timer (both wired in change-1). Iterates each buffered runId and calls
 * `flushControlNoticeBuffer`.
 */
export function flushPendingNotices(
	pi: { sendMessage(msg: unknown, opts: unknown): void },
	globalStore: Record<string, unknown>,
	state: SubagentState,
): void {
	const buffers = globalStore[__piSubagentControlNoticeBuffers] as
		| Map<string, CoalesceBufferEntry>
		| undefined;
	if (!buffers || buffers.size === 0) return;
	// Snapshot keys; flushControlNoticeBuffer mutates the map.
	for (const runId of Array.from(buffers.keys())) {
		flushControlNoticeBuffer(runId, globalStore, state, pi);
	}
}

/** Sweep stale entries from the sync-flush dedup map. */
function sweepSyncFlushDedup(globalStore: Record<string, unknown>, now: number = Date.now()): void {
	const map = globalStore[__piSubagentSyncFlushDedup];
	if (!(map instanceof Map)) return;
	const cutoff = now - SYNC_DEDUP_TTL_MS;
	for (const [key, lastSeenAt] of map as Map<string, number>) {
		if (lastSeenAt < cutoff) map.delete(key);
	}
}

export default function registerSubagentExtension(pi: ExtensionAPI): void {
	const globalStore = globalThis as Record<string, unknown>;
	const runtimeCleanupStoreKey = "__piSubagentRuntimeCleanup";
	const previousRuntimeCleanup = globalStore[runtimeCleanupStoreKey];
	if (typeof previousRuntimeCleanup === "function") {
		try {
			previousRuntimeCleanup();
		} catch {
			// Best effort cleanup for stale timers from an older reload.
		}
	}

	// Lazily initialize globalStore keys so they survive ctx.reload().
	if (!(globalStore[__piSubagentRecentlyTerminalRuns] instanceof Map)) {
		globalStore[__piSubagentRecentlyTerminalRuns] = new Map();
	}
	// improve-control-notice-tuning Section 4: replace pending-notices buffer
	// with the per-runId coalesce buffer + supporting maps.
	if (!(globalStore[__piSubagentControlNoticeBuffers] instanceof Map)) {
		globalStore[__piSubagentControlNoticeBuffers] = new Map();
	}
	if (!(globalStore[__piSubagentSyncFlushDedup] instanceof Map)) {
		globalStore[__piSubagentSyncFlushDedup] = new Map();
	}
	if (!(globalStore[__piSubagentRunFlushEpoch] instanceof Map)) {
		globalStore[__piSubagentRunFlushEpoch] = new Map();
	}
	if (typeof globalStore[__piSubagentDroppedStaleNotices] !== "number") {
		globalStore[__piSubagentDroppedStaleNotices] = 0;
	}
	if (typeof globalStore[__piSubagentDedupedNotices] !== "number") {
		globalStore[__piSubagentDedupedNotices] = 0;
	}
	if (typeof globalStore[__piSubagentDroppedCoalesceOverflow] !== "number") {
		globalStore[__piSubagentDroppedCoalesceOverflow] = 0;
	}
	// __piSubagentSweepTimer and __piSubagentFlushFallbackTimer are left
	// undefined here; Section 7 (timer install/cleanup) owns their lifecycle.

	// Wire liveness globals ONCE before any event handlers are installed.
	setLivenessGlobals(globalStore);

	ensureAccessibleDir(RESULTS_DIR);
	ensureAccessibleDir(ASYNC_DIR);
	cleanupOldChainDirs();

	const config = loadConfig();
	const asyncByDefault = config.asyncByDefault === true;
	const tempArtifactsDir = getArtifactsDir(null);
	cleanupAllArtifactDirs(DEFAULT_ARTIFACT_CONFIG.cleanupDays);

	const state: SubagentState = {
		baseCwd: process.cwd(),
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
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};

	const { startResultWatcher, primeExistingResults, stopResultWatcher } = createResultWatcher(
		pi,
		state,
		RESULTS_DIR,
		10 * 60 * 1000,
	);
	startResultWatcher();
	primeExistingResults();

	let flushToolResultUnsub: (() => void) | undefined;

	const runtimeCleanup = () => {
		// improve-control-notice-tuning Section 9.1: drop coalesce buffers without
		// flushing (stale pi on reload — calling pi.sendMessage from a torn-down
		// pi is undefined behavior). Clear timers first so they can't fire.
		const buffersOnCleanup = globalStore[__piSubagentControlNoticeBuffers] as
			| Map<string, CoalesceBufferEntry>
			| undefined;
		if (buffersOnCleanup && buffersOnCleanup.size > 0) {
			let droppedEvents = 0;
			for (const buffer of buffersOnCleanup.values()) {
				if (buffer.flushTimer) clearTimeout(buffer.flushTimer);
				droppedEvents += buffer.events.length;
			}
			globalStore[__piSubagentDroppedStaleNotices] =
				((globalStore[__piSubagentDroppedStaleNotices] as number) ?? 0) +
				droppedEvents;
			buffersOnCleanup.clear();
		}
		// `__piSubagentLastPi` is the prior registration's pi reference. Unset it
		// so any stale closure that wakes between cleanup and re-registration
		// finds no pi and bails (flushControlNoticeBuffer's defensive `if (!pi)`).
		globalStore[__piSubagentLastPi] = undefined;
		// Section 7: clear sweep timer in addition to existing cleanup.
		if (globalStore[__piSubagentSweepTimer]) {
			clearInterval(globalStore[__piSubagentSweepTimer] as NodeJS.Timeout);
			globalStore[__piSubagentSweepTimer] = undefined;
		}
		// Clear the fallback flush timer.
		if (globalStore[__piSubagentFlushFallbackTimer]) {
			clearInterval(globalStore[__piSubagentFlushFallbackTimer] as NodeJS.Timeout);
			globalStore[__piSubagentFlushFallbackTimer] = undefined;
		}
		// Unsubscribe the flush tool_result listener.
		try {
			flushToolResultUnsub?.();
		} catch {
			// Best effort.
		}
		stopWidgetAnimation();
		stopResultAnimations();
		if (state.poller) {
			clearInterval(state.poller);
			state.poller = null;
		}
	};
	globalStore[runtimeCleanupStoreKey] = runtimeCleanup;

	const { ensurePoller, handleStarted, handleComplete, resetJobs } = createAsyncJobTracker(pi, state, ASYNC_DIR);
	const executor = createSubagentExecutor({
		pi,
		state,
		config,
		asyncByDefault,
		tempArtifactsDir,
		getSubagentSessionRoot,
		expandTilde,
		discoverAgents,
		globalStore,
	});

	pi.registerMessageRenderer<SlashMessageDetails>(SLASH_RESULT_TYPE, (message, options, theme) => {
		const details = resolveSlashMessageDetails(message.details);
		if (!details) return undefined;
		return createSlashResultComponent(details, options, theme, () => state.lastUiContext?.ui.requestRender?.());
	});

	pi.registerMessageRenderer<SubagentNotifyDetails>("subagent-notify", (message, options, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		const details = (message.details as SubagentNotifyDetails | undefined) ?? parseSubagentNotifyContent(content);
		if (!details) return new Text(content, 0, 0);
		const icon = details.status === "completed"
			? theme.fg("success", "✓")
			: details.status === "paused"
				? theme.fg("warning", "■")
				: theme.fg("error", "✗");
		const parts: string[] = [];
		if (details.taskInfo) parts.push(details.taskInfo);
		if (details.durationMs !== undefined) parts.push(formatDuration(details.durationMs));
		let text = `${icon} ${theme.bold(details.agent)} ${theme.fg("dim", details.status)}`;
		if (parts.length > 0) text += ` ${theme.fg("dim", "·")} ${parts.map((part) => theme.fg("dim", part)).join(` ${theme.fg("dim", "·")} `)}`;
		const trimmedPreview = details.resultPreview.trim();
		const previewLines = options.expanded
			? trimmedPreview.split("\n").filter((line) => line.trim())
			: [trimmedPreview.split("\n", 1)[0] ?? ""].filter((line) => line.trim());
		for (const line of previewLines.length > 0 ? previewLines : ["(no output)"]) {
			text += `\n  ${theme.fg("dim", `⎿  ${line}`)}`;
		}
		if (!options.expanded && trimmedPreview.includes("\n")) {
			text += `\n  ${theme.fg("dim", "Ctrl+O full notification")}`;
		}
		if (details.sessionLabel && details.sessionValue) {
			text += `\n  ${theme.fg("muted", `${details.sessionLabel}: ${shortenPath(details.sessionValue)}`)}`;
		}
		return new Text(text, 0, 0);
	});

	pi.registerMessageRenderer<SubagentControlMessageDetails>(SUBAGENT_CONTROL_MESSAGE_TYPE, (message, _options, theme) => {
		const details = message.details as SubagentControlMessageDetails | undefined;
		if (!details?.event) return undefined;
		const content = typeof message.content === "string" ? message.content : undefined;
		return new SubagentControlNoticeComponent({ ...details, noticeText: formatSubagentControlNotice(details, content) }, theme);
	});

	// improve-control-notice-tuning Section 9.2: set the lastPi reference
	// AFTER previousRuntimeCleanup() has run AND AFTER the renderer is
	// registered. Coalesce-buffer flushes will resolve `pi` from this slot.
	globalStore[__piSubagentLastPi] = pi;

	const slashBridge = registerSlashSubagentBridge({
		events: pi.events,
		getContext: () => state.lastUiContext,
		execute: (id, params, signal, onUpdate, ctx) =>
			executor.execute(id, params, signal, onUpdate, ctx),
	});

	const promptTemplateBridge = registerPromptTemplateDelegationBridge({
		events: pi.events,
		getContext: () => state.lastUiContext,
		execute: async (requestId, request, signal, ctx, onUpdate) => {
			if (request.tasks && request.tasks.length > 0) {
				return executor.execute(
					requestId,
					{
						tasks: request.tasks,
						context: request.context,
						cwd: request.cwd,
						worktree: request.worktree,
						async: false,
						clarify: false,
					},
					signal,
					onUpdate,
					ctx,
				);
			}
			return executor.execute(
				requestId,
				{
					agent: request.agent,
					task: request.task,
					context: request.context,
					cwd: request.cwd,
					model: request.model,
					async: false,
					clarify: false,
				},
				signal,
				onUpdate,
				ctx,
			);
		},
	});

	function effectiveParallelTaskCount(tasks: Array<{ count?: unknown }> | undefined): number {
		if (!tasks || tasks.length === 0) return 0;
		return tasks.reduce((total, task) => {
			const count = typeof task.count === "number" && Number.isInteger(task.count) && task.count >= 1 ? task.count : 1;
			return total + count;
		}, 0);
	}

	const tool: ToolDefinition<typeof SubagentParams, Details> = {
		name: "subagent",
		label: "Subagent",
		description: `Delegate to subagents or manage agent definitions.

EXECUTION (use exactly ONE mode):
• Before executing, use { action: "list" } to inspect configured agents/chains. Only execute agents listed as executable/non-disabled.
• SINGLE: { agent, task? } - one task; omit task for self-contained agents
• CHAIN: { chain: [{agent:"agent-a"}, {parallel:[{agent:"agent-b",count:3}]}] } - sequential pipeline with optional parallel fan-out
• PARALLEL: { tasks: [{agent,task,count?,output?,reads?,progress?}, ...], concurrency?: number, worktree?: true } - concurrent execution (worktree: isolate each task in a git worktree)
• Optional context: { context: "fresh" | "fork" } (default: "fresh")

CHAIN TEMPLATE VARIABLES (use in task strings):
• {task} - The original task/request from the user
• {previous} - Text response from the previous step (empty for first step)
• {chain_dir} - Shared directory for chain files (e.g., <tmpdir>/pi-subagents-<scope>/chain-runs/abc123/)

Example: { chain: [{agent:"agent-a", task:"Analyze {task}"}, {agent:"agent-b", task:"Plan based on {previous}"}] }

MANAGEMENT (use action field, omit agent/task/chain/tasks):
• { action: "list" } - discover executable agents/chains and any disabled builtins
• { action: "get", agent: "name" } - full detail
• { action: "create", config: { name, systemPrompt, systemPromptMode, inheritProjectContext, inheritSkills, ... } }
• { action: "update", agent: "name", config: { ... } } - merge
• { action: "delete", agent: "name" }
• Use chainName for chain operations

CONTROL:
• { action: "status", id: "..." } - inspect an async/background run by id or prefix
• { action: "interrupt", id?: "..." } - soft-interrupt the current child turn and leave the run paused

DIAGNOSTICS:
• { action: "doctor" } - read-only report for runtime paths, discovery, sessions, and intercom`,
		parameters: SubagentParams,

		execute(id, params, signal, onUpdate, ctx) {
			return executor.execute(id, params, signal, onUpdate, ctx);
		},

		renderCall(args, theme) {
			if (args.action) {
				const target = args.agent || args.chainName || "";
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}${args.action}${target ? ` ${theme.fg("accent", target)}` : ""}`,
					0, 0,
				);
			}
			const isParallel = (args.tasks?.length ?? 0) > 0;
			const parallelCount = effectiveParallelTaskCount(args.tasks as Array<{ count?: unknown }> | undefined);
			const asyncLabel = args.async === true && !isParallel ? theme.fg("warning", " [async]") : "";
			if (args.chain?.length)
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}chain (${args.chain.length})${asyncLabel}`,
					0,
					0,
				);
			if (isParallel)
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}parallel (${parallelCount})`,
					0,
					0,
				);
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent || "?")}${asyncLabel}`,
				0,
				0,
			);
		},

		renderResult(result, options, theme, context) {
			syncResultAnimation(result, context);
			return renderSubagentResult(result, options, theme);
		},

	};

	pi.registerTool(tool);
	registerSlashCommands(pi, state);

	const eventUnsubscribeStoreKey = "__piSubagentEventUnsubscribes";
	const previousEventUnsubscribes = globalStore[eventUnsubscribeStoreKey];
	if (Array.isArray(previousEventUnsubscribes)) {
		for (const unsubscribe of previousEventUnsubscribes) {
			if (typeof unsubscribe !== "function") continue;
			try {
				unsubscribe();
			} catch {
				// Best effort cleanup for stale handlers from an older reload.
			}
		}
	}
	registerSubagentNotify(pi);

	const existingVisibleControlNotices = globalStore[visibleControlNoticesStoreKey];
	const visibleControlNotices =
		existingVisibleControlNotices instanceof Set
			? (existingVisibleControlNotices as Set<string>)
			: new Set<string>();
	globalStore[visibleControlNoticesStoreKey] = visibleControlNotices;

	// Task 5.3: NEW flush listener — fires for every subagent tool_result regardless
	// of ctx.hasUI. Separate from the existing handler below (which early-returns on
	// !ctx.hasUI and handles widget rendering). The unsub is stored in flushToolResultUnsub
	// so runtimeCleanup can call it.
	flushToolResultUnsub = pi.on("tool_result", (event, _ctx) => {
		if (event.toolName !== "subagent") return;
		flushPendingNotices(pi, globalStore, state);
	});

	// Task 5.4: Fallback flush timer (5s). Clear any stale timer from a prior reload
	// before installing a fresh one.
	if (globalStore[__piSubagentFlushFallbackTimer]) {
		clearInterval(globalStore[__piSubagentFlushFallbackTimer] as NodeJS.Timeout);
	}
	const flushFallback = setInterval(() => {
		flushPendingNotices(pi, globalStore, state);
	}, 5_000);
	flushFallback.unref();
	globalStore[__piSubagentFlushFallbackTimer] = flushFallback;

	// Section 7: install the recently-terminal sweep timer (60s). Clear any stale
	// timer from a prior reload before installing a fresh one (Task 7.1).
	if (globalStore[__piSubagentSweepTimer]) {
		clearInterval(globalStore[__piSubagentSweepTimer] as NodeJS.Timeout);
	}
	const sweepTimer = setInterval(() => {
		sweepRecentTerminalRuns(globalStore);
		// improve-control-notice-tuning: also sweep the sync-flush dedup map.
		sweepSyncFlushDedup(globalStore);
	}, 60_000);
	sweepTimer.unref();
	globalStore[__piSubagentSweepTimer] = sweepTimer;

	const controlEventHandler = (payload: unknown) => {
		processControlEvent(payload, globalStore, state, visibleControlNotices);
	};
	const eventUnsubscribes = [
		pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, handleStarted),
		pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, handleComplete),
		pi.events.on(SUBAGENT_CONTROL_EVENT, controlEventHandler),
	];
	globalStore[eventUnsubscribeStoreKey] = eventUnsubscribes;

	// Existing tool_result handler (widget rendering, UI-only). Left unchanged.
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "subagent") return;
		if (!ctx.hasUI) return;
		state.lastUiContext = ctx;
		if (state.asyncJobs.size > 0) {
			renderWidget(ctx, Array.from(state.asyncJobs.values()));
			ensurePoller();
		}
	});

	const cleanupSessionArtifacts = (ctx: ExtensionContext) => {
		try {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (sessionFile) {
				cleanupOldArtifacts(getArtifactsDir(sessionFile), DEFAULT_ARTIFACT_CONFIG.cleanupDays);
			}
		} catch {
			// Cleanup failures should not block session lifecycle events.
		}
	};

	const resetSessionState = (ctx: ExtensionContext) => {
		state.baseCwd = ctx.cwd;
		state.currentSessionId = ctx.sessionManager.getSessionFile() ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		state.lastUiContext = ctx;
		cleanupSessionArtifacts(ctx);
		resetJobs(ctx);
		restoreSlashFinalSnapshots(ctx.sessionManager.getEntries());
	};

	pi.on("session_start", (_event, ctx) => {
		resetSessionState(ctx);
	});
	pi.on("session_shutdown", () => {
		for (const unsubscribe of eventUnsubscribes) {
			try {
				unsubscribe();
			} catch {
				// Best effort cleanup during shutdown.
			}
		}
		if (globalStore[eventUnsubscribeStoreKey] === eventUnsubscribes) {
			delete globalStore[eventUnsubscribeStoreKey];
		}
		stopResultWatcher();
		if (state.poller) clearInterval(state.poller);
		state.poller = null;
		for (const timer of state.cleanupTimers.values()) {
			clearTimeout(timer);
		}
		state.cleanupTimers.clear();
		state.asyncJobs.clear();
		clearSlashSnapshots();
		slashBridge.cancelAll();
		slashBridge.dispose();
		promptTemplateBridge.cancelAll();
		promptTemplateBridge.dispose();
		stopWidgetAnimation();
		stopResultAnimations();
		// improve-control-notice-tuning Section 9.3: clear all tuning state on
		// shutdown so pending flush timers cannot fire post-shutdown and no
		// ghost notices are emitted.
		const buffersOnShutdown = globalStore[__piSubagentControlNoticeBuffers] as
			| Map<string, CoalesceBufferEntry>
			| undefined;
		if (buffersOnShutdown) {
			for (const buffer of buffersOnShutdown.values()) {
				if (buffer.flushTimer) clearTimeout(buffer.flushTimer);
			}
			buffersOnShutdown.clear();
		}
		const syncDedup = globalStore[__piSubagentSyncFlushDedup];
		if (syncDedup instanceof Map) syncDedup.clear();
		const flushEpoch = globalStore[__piSubagentRunFlushEpoch];
		if (flushEpoch instanceof Map) flushEpoch.clear();
		globalStore[__piSubagentLastPi] = undefined;
		if (globalStore[runtimeCleanupStoreKey] === runtimeCleanup) {
			delete globalStore[runtimeCleanupStoreKey];
		}
		if (state.lastUiContext?.hasUI) {
			state.lastUiContext.ui.setWidget(WIDGET_KEY, undefined);
		}
	});
}
