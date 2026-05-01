import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { formatAsyncRunList, listAsyncRuns } from "./async-status.ts";
import {
	formatForegroundActivity,
	getForegroundControl,
	type ForegroundControl,
} from "./foreground-control.ts";
import { RECENT_TERMINAL_TTL_MS, type RecentTerminalEntry } from "./recent-terminal.ts";
import { ASYNC_DIR, RESULTS_DIR, type Details, type SubagentState } from "./types.ts";
import { findByPrefix, readStatus } from "./utils.ts";

export interface RunStatusParams {
	action?: "status";
	id?: string;
	runId?: string;
	dir?: string;
}

function activityText(activityState: unknown, lastActivityAt: unknown): string | undefined {
	if (typeof lastActivityAt !== "number") return undefined;
	const seconds = Math.floor(Math.max(0, Date.now() - lastActivityAt) / 1000);
	return activityState === "needs_attention" ? `no activity for ${seconds}s` : `active ${seconds}s ago`;
}

interface PrefixMatch<T> {
	exact: boolean;
	value?: T;
	ambiguous?: boolean;
}

/**
 * Look up an in-memory map by exact id or unique prefix. Mirrors
 * `findByPrefix` (which works on filesystem dirs) but for `Map` keys.
 *
 * Returns:
 *   - { exact: true, value }  when an exact-id hit
 *   - { exact: false, value } when a UNIQUE prefix matches
 *   - { exact: false, ambiguous: true } when 2+ candidates match
 *   - { exact: false }         when no candidates match
 */
function findInMapByPrefix<T>(
	map: Map<string, T> | undefined,
	id: string,
	filter?: (key: string, value: T) => boolean,
): PrefixMatch<T> {
	if (!map) return { exact: false };
	const direct = map.get(id);
	if (direct !== undefined && (!filter || filter(id, direct))) {
		return { exact: true, value: direct };
	}
	let match: T | undefined;
	let count = 0;
	for (const [key, value] of map) {
		if (!key.startsWith(id)) continue;
		if (filter && !filter(key, value)) continue;
		match = value;
		count += 1;
		if (count > 1) return { exact: false, ambiguous: true };
	}
	if (count === 1) return { exact: false, value: match };
	return { exact: false };
}

/**
 * Build the status response for a foreground-control hit.
 */
function foregroundStatusResponse(control: ForegroundControl): AgentToolResult<Details> {
	const activity = formatForegroundActivity(control);
	const lines = [
		`Run: ${control.runId}`,
		"State: running",
		`Mode: ${control.mode}`,
		control.currentAgent
			? `Current: ${control.currentAgent}${
					control.currentIndex !== undefined ? ` step ${control.currentIndex + 1}` : ""
				}`
			: undefined,
		activity ? `Activity: ${activity}` : undefined,
	].filter((line): line is string => Boolean(line));
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			mode: "management",
			results: [],
			lookup: "foreground",
			id: control.runId,
			runMode: control.mode,
			currentAgent: control.currentAgent,
			currentIndex: control.currentIndex,
			lastActivityAt: control.lastActivityAt,
			activityState: control.currentActivityState,
			durationMs: Math.max(0, Date.now() - control.startedAt),
		},
	};
}

/**
 * Build the status response for a recently-terminal hit.
 */
function recentlyTerminalResponse(
	id: string,
	entry: RecentTerminalEntry,
): AgentToolResult<Details> {
	const ageSeconds = Math.max(0, Math.floor((Date.now() - entry.terminatedAt) / 1000));
	return {
		content: [
			{
				type: "text",
				text:
					`Run ${id} ended ${ageSeconds}s ago (${entry.terminalState}); ` +
					"full transcript no longer in memory. Inspect the parent tool result for final output.",
			},
		],
		details: {
			mode: "management",
			results: [],
			lookup: "recently-terminal",
			id,
			terminalState: entry.terminalState,
			terminatedAt: entry.terminatedAt,
			ageSeconds,
		},
	};
}

/**
 * Inspect the status of a subagent run across four stores in precedence
 * order: async > results > foreground > recently-terminal.
 *
 * @param state - Optional. When omitted, only async/results branches resolve;
 *   foreground / recently-terminal lookups are skipped. Legacy callers and
 *   tests can call without state for the prior behavior.
 * @param globalStore - Optional. When omitted, recently-terminal lookup is
 *   skipped (the map is read from `globalStore.__piSubagentRecentlyTerminalRuns`).
 */
export function inspectSubagentStatus(
	params: RunStatusParams,
	state?: SubagentState,
	globalStore?: Record<string, unknown>,
): AgentToolResult<Details> {
	if (!params.id && !params.runId && !params.dir) {
		// Three-tier no-id fallback before falling through to the aggregator path.
		// Tier 1: state.lastForegroundControlId
		// Tier 2: newest foreground control by updatedAt
		// Tier 3: aggregator (existing behavior below)
		if (state && state.foregroundControls && state.foregroundControls.size > 0) {
			const control = getForegroundControl(state, undefined);
			if (control) return foregroundStatusResponse(control);
		}
		try {
			const runs = listAsyncRuns(ASYNC_DIR, { states: ["queued", "running"] });
			return {
				content: [{ type: "text", text: formatAsyncRunList(runs) }],
				details: { mode: "single", results: [] },
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text", text: message }],
				isError: true,
				details: { mode: "single", results: [] },
			};
		}
	}

	let asyncDir: string | null = null;
	let resolvedId = params.id ?? params.runId;

	if (params.dir) {
		// Explicit dir bypasses foreground/recently-terminal — go straight to disk.
		asyncDir = path.resolve(params.dir);
	} else if (resolvedId) {
		const direct = path.join(ASYNC_DIR, resolvedId);
		if (fs.existsSync(direct)) {
			asyncDir = direct;
		} else {
			const match = findByPrefix(ASYNC_DIR, resolvedId);
			if (match) {
				asyncDir = match;
				resolvedId = path.basename(match);
			}
		}
	}

	const resultPath = resolvedId && !asyncDir ? findByPrefix(RESULTS_DIR, resolvedId, ".json") : null;

	// ── Branch 1: async directory hit ─────────────────────────────────────────
	if (asyncDir) {
		let status;
		try {
			status = readStatus(asyncDir);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text", text: message }],
				isError: true,
				details: { mode: "single", results: [] },
			};
		}
		const logPath = path.join(asyncDir, `subagent-log-${resolvedId ?? "unknown"}.md`);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		if (status) {
			const stepsTotal = status.steps?.length ?? 1;
			const current = status.currentStep !== undefined ? status.currentStep + 1 : undefined;
			const stepLine = current !== undefined ? `Step: ${current}/${stepsTotal}` : `Steps: ${stepsTotal}`;
			const started = new Date(status.startedAt).toISOString();
			const updated = status.lastUpdate ? new Date(status.lastUpdate).toISOString() : "n/a";
			const statusActivityText = status.state === "running" ? activityText(status.activityState, status.lastActivityAt) : undefined;

			const lines = [
				`Run: ${status.runId}`,
				`State: ${status.state}`,
				statusActivityText ? `Activity: ${statusActivityText}` : undefined,
				`Mode: ${status.mode}`,
				stepLine,
				`Started: ${started}`,
				`Updated: ${updated}`,
				`Dir: ${asyncDir}`,
			].filter((line): line is string => Boolean(line));
			for (const [index, step] of (status.steps ?? []).entries()) {
				const stepActivityText = step.status === "running" ? activityText(step.activityState, step.lastActivityAt) : undefined;
				lines.push(`Step ${index + 1}: ${step.agent} ${step.status}${stepActivityText ? `, ${stepActivityText}` : ""}`);
			}
			if (status.sessionFile) lines.push(`Session: ${status.sessionFile}`);
			if (fs.existsSync(logPath)) lines.push(`Log: ${logPath}`);
			if (fs.existsSync(eventsPath)) lines.push(`Events: ${eventsPath}`);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { mode: "single", results: [], lookup: "async" },
			};
		}
	}

	// ── Branch 2: results envelope hit ────────────────────────────────────────
	if (resultPath) {
		try {
			const raw = fs.readFileSync(resultPath, "utf-8");
			const data = JSON.parse(raw) as { id?: string; success?: boolean; summary?: string; exitCode?: number; state?: string };
			const status = data.success ? "complete" : data.state === "paused" || data.exitCode === 0 ? "paused" : "failed";
			const lines = [`Run: ${data.id ?? resolvedId}`, `State: ${status}`, `Result: ${resultPath}`];
			if (data.summary) lines.push("", data.summary);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { mode: "single", results: [], lookup: "results" },
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text", text: `Failed to read async result file: ${message}` }],
				isError: true,
				details: { mode: "single", results: [] },
			};
		}
	}

	// Skip foreground/recently-terminal branches when --dir was provided
	// (caller is asking about a specific on-disk dir, not an in-memory run).
	if (params.dir) {
		return {
			content: [{ type: "text", text: "Status file not found." }],
			isError: true,
			details: { mode: "single", results: [] },
		};
	}

	// ── Branch 3: foreground control hit ──────────────────────────────────────
	if (state && state.foregroundControls && resolvedId) {
		const fgMatch = findInMapByPrefix<ForegroundControl>(state.foregroundControls, resolvedId);
		if (fgMatch.ambiguous) {
			return {
				content: [
					{
						type: "text",
						text: `Ambiguous prefix '${resolvedId}' matches multiple foreground runs. Provide a longer id.`,
					},
				],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
		if (fgMatch.value) return foregroundStatusResponse(fgMatch.value);
	}

	// ── Branch 4: recently-terminal hit (lookup-time TTL gate) ────────────────
	if (globalStore && resolvedId) {
		const recentlyTerminalMap = (globalStore as { __piSubagentRecentlyTerminalRuns?: Map<string, RecentTerminalEntry> })
			.__piSubagentRecentlyTerminalRuns;
		const now = Date.now();
		const stillFresh = (_key: string, entry: RecentTerminalEntry) =>
			now - entry.terminatedAt < RECENT_TERMINAL_TTL_MS;
		const rtMatch = findInMapByPrefix<RecentTerminalEntry>(
			recentlyTerminalMap,
			resolvedId,
			stillFresh,
		);
		if (rtMatch.ambiguous) {
			return {
				content: [
					{
						type: "text",
						text: `Ambiguous prefix '${resolvedId}' matches multiple recently-terminal runs. Provide a longer id.`,
					},
				],
				isError: true,
				details: { mode: "management", results: [] },
			};
		}
		if (rtMatch.value) {
			// Resolve to the actual key for the response id.
			let resolvedKey = resolvedId;
			if (!rtMatch.exact && recentlyTerminalMap) {
				for (const [key, entry] of recentlyTerminalMap) {
					if (key.startsWith(resolvedId) && now - entry.terminatedAt < RECENT_TERMINAL_TTL_MS) {
						resolvedKey = key;
						break;
					}
				}
			}
			return recentlyTerminalResponse(resolvedKey, rtMatch.value);
		}
	}

	// All branches missed.
	return {
		content: [{ type: "text", text: "Async run not found. Provide id or dir." }],
		isError: true,
		details: { mode: "single", results: [] },
	};
}
