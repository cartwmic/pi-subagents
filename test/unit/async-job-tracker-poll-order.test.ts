/**
 * Regression test: Decision 9 poll-order reorder.
 *
 * Asserts that `readStatus` (and the resulting `job.status` update) runs
 * BEFORE `emitNewControlEvents` is called inside the poll loop.
 *
 * Strategy: create a real asyncDir on disk with
 *   - status.json  → state: "complete"
 *   - events.jsonl → one valid subagent.control line
 *
 * The fake `pi.events.emit` spy fires when emitNewControlEvents processes
 * the events.jsonl line.  At that moment we capture `job.status` from
 * `state.asyncJobs`.  If the order is correct, `job.status` must already
 * be "complete" (read from status.json), NOT the original "running".
 *
 * NOTE: async-job-tracker.ts transitively imports render.ts which imports
 * @mariozechner/pi-coding-agent (a value import; not stripped). That package
 * is not installed in the unit-test environment.  We intercept render.ts at
 * module-load time via node:module.register() + a data-URL loader BEFORE the
 * dynamic import of async-job-tracker.ts.  No new source files are created.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import * as fs from "node:fs";
import { register } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import type { SubagentState } from "../../types.ts";
import { SUBAGENT_CONTROL_EVENT } from "../../types.ts";

// ---------------------------------------------------------------------------
// Stub render.ts so @mariozechner/pi-coding-agent is never resolved.
// Must be registered before the dynamic import below.
// ---------------------------------------------------------------------------
const stubLoader = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('render.ts') || specifier.endsWith('render.js')) {
    return { shortCircuit: true, url: 'data:text/javascript,export function renderWidget() {}' };
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(stubLoader)}`, import.meta.url);

// Dynamic import so the stub loader above is already in effect.
const { createAsyncJobTracker } = (await import("../../async-job-tracker.ts")) as {
	createAsyncJobTracker: (
		pi: { events: { emit(name: string, payload: unknown): boolean } },
		state: SubagentState,
		asyncDirRoot: string,
		options?: { pollIntervalMs?: number; completionRetentionMs?: number },
	) => {
		ensurePoller(): void;
		handleStarted(data: unknown): void;
		handleComplete(data: unknown): void;
		resetJobs(ctx?: unknown): void;
	};
};

// ---------------------------------------------------------------------------
// Minimal SubagentState — only fields touched by createAsyncJobTracker
// ---------------------------------------------------------------------------
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
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	} as unknown as SubagentState;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe("async-job-tracker poll order (Decision 9)", () => {
	const tempDirs: string[] = [];

	after(() => {
		for (const dir of tempDirs) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("job.status reflects disk value BEFORE emitNewControlEvents is called", async () => {
		const asyncId = "poll-order-regression-run";
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-poll-order-"));
		tempDirs.push(tempDir);

		// Write status.json reporting "complete"
		const statusPayload = {
			runId: asyncId,
			mode: "single",
			state: "complete",
			startedAt: Date.now(),
			lastUpdate: Date.now(),
		};
		fs.writeFileSync(path.join(tempDir, "status.json"), JSON.stringify(statusPayload));

		// Write events.jsonl with one valid subagent.control entry so
		// emitNewControlEvents will call pi.events.emit exactly once.
		const controlLine = JSON.stringify({
			type: "subagent.control",
			event: {
				type: "needs_attention",
				runId: asyncId,
				to: "stuck",
				ts: Date.now(),
				agent: "test-agent",
				message: "test notice",
			},
			channels: ["event"],
			noticeText: "test notice",
		});
		fs.writeFileSync(path.join(tempDir, "events.jsonl"), controlLine + "\n");

		const state = makeState();
		// Section 6.2 gate: classifyRunForNotice(state, runId) === "stale" suppresses
		// the emit for terminal async statuses. To pin the poll-order without the
		// gate masking the spy, register the run in state.foregroundControls so the
		// classifier returns "live" regardless of the async job status. The poll
		// loop's status read still races: this test asserts that by the time emit
		// fires, job.status reflects the disk value ("complete"), not the pre-poll
		// override ("running").
		state.foregroundControls.set(asyncId, {
			runId: asyncId,
			agent: "test-agent",
			interrupt: () => false,
			updatedAt: Date.now(),
		} as never);

		// Promise that resolves (with captured status) when the spy fires.
		let resolveEmit!: (status: string) => void;
		const emitFired = new Promise<string>((res) => {
			resolveEmit = res;
		});

		const mockPi = {
			events: {
				emit(eventName: string, _payload: unknown): boolean {
					if (eventName === SUBAGENT_CONTROL_EVENT) {
						// Capture job.status AT the exact moment pi.events.emit is called.
						const job = state.asyncJobs.get(asyncId);
						resolveEmit(job?.status ?? "(not found)");
					}
					return true;
				},
			},
		};

		const tracker = createAsyncJobTracker(mockPi, state, os.tmpdir(), {
			pollIntervalMs: 1,
			completionRetentionMs: 60_000, // keep job alive long enough to inspect
		});

		// Register the job; ensurePoller() is called internally.
		tracker.handleStarted({ id: asyncId, asyncDir: tempDir });
		// Override to "running" so the running→complete transition is observable.
		state.asyncJobs.get(asyncId)!.status = "running";

		// Add a deadline so the test doesn't hang if the poll never fires.
		const deadline = new Promise<string>((_, rej) =>
			setTimeout(() => rej(new Error("poll did not fire within 1000ms")), 1000),
		);

		let capturedStatus: string;
		try {
			capturedStatus = await Promise.race([emitFired, deadline]);
		} finally {
			// Stop the interval so the test runner exits cleanly.
			if (state.poller) clearInterval(state.poller);
			// Cancel the cleanup timer.
			for (const t of state.cleanupTimers.values()) clearTimeout(t);
		}

		assert.equal(
			capturedStatus,
			"complete",
			`job.status should be "complete" (read from disk) at the time emitNewControlEvents ` +
				`calls pi.events.emit, but was "${capturedStatus}". ` +
				`This pins the Decision 9 poll-order reorder: readStatus must precede emitNewControlEvents.`,
		);
	});
});
