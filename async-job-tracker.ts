import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { classifyRunForNotice } from "./liveness.ts";
import { recordTerminalRun } from "./recent-terminal.ts";
import { renderWidget } from "./render.ts";
import { formatControlNoticeMessage } from "./subagent-control.ts";
import {
	type AsyncJobState,
	type ControlEvent,
	type SubagentState,
	POLL_INTERVAL_MS,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
} from "./types.ts";
import { readStatus } from "./utils.ts";

const globalStore = globalThis as Record<string, unknown>;

interface AsyncJobTrackerOptions {
	completionRetentionMs?: number;
	pollIntervalMs?: number;
}

export function createAsyncJobTracker(pi: Pick<ExtensionAPI, "events">, state: SubagentState, asyncDirRoot: string, options: AsyncJobTrackerOptions = {}): {
	ensurePoller: () => void;
	handleStarted: (data: unknown) => void;
	handleComplete: (data: unknown) => void;
	resetJobs: (ctx?: ExtensionContext) => void;
} {
	const completionRetentionMs = options.completionRetentionMs ?? 10000;
	const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
	const rerenderWidget = (ctx: ExtensionContext, jobs = Array.from(state.asyncJobs.values())) => {
		renderWidget(ctx, jobs);
		ctx.ui.requestRender?.();
	};
	const scheduleCleanup = (asyncId: string) => {
		const existingTimer = state.cleanupTimers.get(asyncId);
		if (existingTimer) clearTimeout(existingTimer);
		const timer = setTimeout(() => {
			state.cleanupTimers.delete(asyncId);
			state.asyncJobs.delete(asyncId);
			if (state.lastUiContext) {
				rerenderWidget(state.lastUiContext);
			}
		}, completionRetentionMs);
		state.cleanupTimers.set(asyncId, timer);
	};
	const emitNewControlEvents = (job: AsyncJobState) => {
		const eventsPath = path.join(job.asyncDir, "events.jsonl");
		let fd: number;
		try {
			fd = fs.openSync(eventsPath, "r");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			console.error(`Failed to open async control events for '${job.asyncDir}':`, error);
			return;
		}
		try {
			const stat = fs.fstatSync(fd);
			const cursor = stat.size < (job.controlEventCursor ?? 0) ? 0 : (job.controlEventCursor ?? 0);
			if (stat.size <= cursor) return;
			const buffer = Buffer.alloc(stat.size - cursor);
			fs.readSync(fd, buffer, 0, buffer.length, cursor);
			const lastNewline = buffer.lastIndexOf(0x0a);
			if (lastNewline === -1) return;
			job.controlEventCursor = cursor + lastNewline + 1;
			for (const line of buffer.subarray(0, lastNewline).toString("utf-8").split("\n")) {
				if (!line.trim()) continue;
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch {
					// Ignore malformed completed records but keep the poller alive for later events.
					continue;
				}
				if (!parsed || typeof parsed !== "object" || (parsed as { type?: unknown }).type !== "subagent.control") continue;
				const record = parsed as {
					event?: ControlEvent;
					channels?: string[];
					childIntercomTarget?: string;
					noticeText?: string;
					intercom?: { to?: string; message?: string };
					needsAttentionAfterMs?: number;
					coalesceWindowMs?: number;
				};
				if (!record.event || !Array.isArray(record.channels)) continue;
				const payload = {
					event: record.event,
					source: "async" as const,
					asyncDir: job.asyncDir,
					childIntercomTarget: record.childIntercomTarget,
					noticeText: record.noticeText ?? formatControlNoticeMessage(record.event, record.childIntercomTarget),
					// Section 3.4 (improve-control-notice-tuning): forward whatever
					// the runner wrote (older runs omit these; receiver falls back to
					// loadConfig() per task 3.6).
					needsAttentionAfterMs: record.needsAttentionAfterMs,
					coalesceWindowMs: record.coalesceWindowMs,
				};
				// Layer B gate (Section 6): drop replayed events for runs that have
				// already terminated. The async tracker reads events.jsonl after the
				// runner has already written them, so the run is often stale by now.
				const runId = record.event.runId;
				if (record.channels.includes("event")) {
					if (classifyRunForNotice(state, runId) !== "stale") {
						pi.events.emit(SUBAGENT_CONTROL_EVENT, payload);
					}
				}
				if (record.channels.includes("intercom") && record.intercom?.to && record.intercom.message) {
					if (classifyRunForNotice(state, runId) !== "stale") {
						pi.events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, {
							...payload,
							to: record.intercom.to,
							message: record.intercom.message,
						});
					}
				}
			}
		} catch (error) {
			console.error(`Failed to read async control events for '${job.asyncDir}':`, error);
		} finally {
			fs.closeSync(fd);
		}
	};

	const ensurePoller = () => {
		if (state.poller) return;
		state.poller = setInterval(() => {
			if (state.asyncJobs.size === 0) {
				if (state.lastUiContext?.hasUI) rerenderWidget(state.lastUiContext, []);
				if (state.poller) {
					clearInterval(state.poller);
					state.poller = null;
				}
				return;
			}

			for (const job of state.asyncJobs.values()) {
				try {
					// Decision 9: read disk status BEFORE emitting control events so the
					// bus-emit gate (Batch 5) sees the just-transitioned job.status.
					const previousStatus = job.status;
					const status = readStatus(job.asyncDir);
					if (status) {
						job.status = status.state;
						job.activityState = status.activityState;
						job.lastActivityAt = status.lastActivityAt ?? job.lastActivityAt;
						job.currentTool = status.currentTool ?? job.currentTool;
						job.currentToolStartedAt = status.currentToolStartedAt ?? job.currentToolStartedAt;
						job.mode = status.mode;
						job.currentStep = status.currentStep ?? job.currentStep;
						job.stepsTotal = status.steps?.length ?? job.stepsTotal;
						job.startedAt = status.startedAt ?? job.startedAt;
						job.updatedAt = status.lastUpdate ?? Date.now();
						if (status.steps?.length) {
							job.agents = status.steps.map((step) => step.agent);
						}
						job.sessionDir = status.sessionDir ?? job.sessionDir;
						job.outputFile = status.outputFile ?? job.outputFile;
						job.totalTokens = status.totalTokens ?? job.totalTokens;
						job.sessionFile = status.sessionFile ?? job.sessionFile;
					} else {
						job.status = job.status === "queued" ? "running" : job.status;
						job.updatedAt = Date.now();
					}
					emitNewControlEvents(job);
					if (status && (job.status === "complete" || job.status === "failed" || job.status === "paused") && previousStatus !== job.status) {
						if (job.status === "complete" || job.status === "failed") {
							recordTerminalRun(
								globalStore,
								job.asyncId,
								job.status === "complete" ? "succeeded" : "failed",
							);
						}
						scheduleCleanup(job.asyncId);
					}
				} catch (error) {
					console.error(`Failed to read async status for '${job.asyncDir}':`, error);
					job.status = "failed";
					job.updatedAt = Date.now();
				}
			}

			if (state.lastUiContext?.hasUI) rerenderWidget(state.lastUiContext);
		}, pollIntervalMs);
		state.poller.unref?.();
	};

	const handleStarted = (data: unknown) => {
		const info = data as {
			id?: string;
			asyncDir?: string;
			agent?: string;
			chain?: string[];
		};
		if (!info.id) return;
		const now = Date.now();
		const asyncDir = info.asyncDir ?? path.join(asyncDirRoot, info.id);
		const agents = info.chain && info.chain.length > 0 ? info.chain : info.agent ? [info.agent] : undefined;
		state.asyncJobs.set(info.id, {
			asyncId: info.id,
			asyncDir,
			status: "queued",
			mode: info.chain ? "chain" : "single",
			agents,
			stepsTotal: agents?.length,
			startedAt: now,
			updatedAt: now,
		});
		ensurePoller();
		if (state.lastUiContext) {
			rerenderWidget(state.lastUiContext);
		}
	};

	const handleComplete = (data: unknown) => {
		const result = data as { id?: string; success?: boolean; asyncDir?: string };
		const asyncId = result.id;
		if (!asyncId) return;
		const job = state.asyncJobs.get(asyncId);
		if (job) {
			job.status = result.success ? "complete" : "failed";
			job.updatedAt = Date.now();
			if (result.asyncDir) job.asyncDir = result.asyncDir;
		}
		if (state.lastUiContext) {
			rerenderWidget(state.lastUiContext);
		}
		// First-write-wins in recordTerminalRun handles dedup with the poll branch.
		recordTerminalRun(
			globalStore,
			asyncId,
			result.success ? "succeeded" : "failed",
		);
		scheduleCleanup(asyncId);
	};

	const resetJobs = (ctx?: ExtensionContext) => {
		for (const timer of state.cleanupTimers.values()) {
			clearTimeout(timer);
		}
		state.cleanupTimers.clear();
		state.asyncJobs.clear();
		state.foregroundControls?.clear();
		state.lastForegroundControlId = null;
		state.resultFileCoalescer.clear();
		if (ctx?.hasUI) {
			state.lastUiContext = ctx;
			rerenderWidget(ctx, []);
		}
	};

	return { ensurePoller, handleStarted, handleComplete, resetJobs };
}
