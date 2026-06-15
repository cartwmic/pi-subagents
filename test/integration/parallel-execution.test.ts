/**
 * Integration tests for parallel execution.
 *
 * Tests the mapConcurrent utility and parallel agent spawning via runSync.
 * The top-level parallel mode (params.tasks) lives in index.ts and uses
 * mapConcurrent + runSync — we test both pieces here.
 *
 * mapConcurrent tests always run. runSync tests require pi packages.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import {
	createEventBus,
	createMockPi,
	createTempDir,
	makeAgent,
	makeAgentConfigs,
	makeMinimalCtx,
	removeTempDir,
	tryImport,
} from "../support/helpers.ts";

// Top-level await: try importing pi-dependent modules
const utils = await tryImport<any>("./utils.ts");
const execution = await tryImport<any>("./execution.ts");
const executorMod = await tryImport<any>("./subagent-executor.ts");
const piAvailable = !!(execution && utils);

const typesMod = await tryImport<any>("./types.ts");

const runSync = execution?.runSync;
const mapConcurrent = utils?.mapConcurrent;
const mapSettled = utils?.mapSettled;
const buildFailedSingleResult = typesMod?.buildFailedSingleResult;
const createSubagentExecutor = executorMod?.createSubagentExecutor;

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const value = fn();
		if (value !== undefined && value !== false) return value as T;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`timeout waiting for ${label}`);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_resolve, reject) =>
			setTimeout(() => reject(new Error(`timeout: ${label}`)), timeoutMs).unref?.(),
		),
	]);
}

// ---------------------------------------------------------------------------
// mapConcurrent — always runs (pure logic, no pi deps beyond utils.ts)
// ---------------------------------------------------------------------------

describe("mapConcurrent", { skip: !mapConcurrent ? "utils not importable" : undefined }, () => {
	it("processes all items", async () => {
		const items = [1, 2, 3, 4, 5];
		const results = await mapConcurrent(items, 2, async (item: number) => item * 2);
		assert.deepEqual(results, [2, 4, 6, 8, 10]);
	});

	it("preserves order regardless of completion time", async () => {
		const items = [80, 10, 40]; // delays in ms
		const results = await mapConcurrent(items, 3, async (ms: number, i: number) => {
			await new Promise((r) => setTimeout(r, ms));
			return i;
		});
		assert.deepEqual(results, [0, 1, 2], "results should be in original order");
	});

	it("respects concurrency limit", async () => {
		let running = 0;
		let maxRunning = 0;
		const items = [1, 2, 3, 4, 5, 6];

		await mapConcurrent(items, 2, async () => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((r) => setTimeout(r, 20));
			running--;
		});

		assert.ok(maxRunning <= 2, `max concurrent should be ≤ 2, got ${maxRunning}`);
	});

	it("handles empty array", async () => {
		const results = await mapConcurrent([], 4, async (item: unknown) => item);
		assert.deepEqual(results, []);
	});

	it("propagates errors (fail-fast variant still rejects)", async () => {
		// mapConcurrent retains fail-fast Promise.all semantics for callers that
		// explicitly want it; the parallel batch callers use mapSettled instead.
		await assert.rejects(
			() =>
				mapConcurrent([1, 2, 3], 2, async (item: number) => {
					if (item === 2) throw new Error("boom");
					return item;
				}),
			/boom/,
		);
	});
});

describe("mapSettled", { skip: !mapSettled ? "utils not importable" : undefined }, () => {
	// AC: subagent-parallel-recovery.concurrency-pool-settles-not-throws
	it("settles with partials instead of rejecting on the first error", async () => {
		const results = await mapSettled(
			[1, 2, 3],
			2,
			async (item: number) => {
				if (item === 2) throw new Error("boom");
				return `ok-${item}`;
			},
			(error: unknown, item: number) => `failed-${item}:${(error as Error).message}`,
		);
		// Successful siblings preserved; failed slot replaced by fallback; order kept.
		assert.deepEqual(results, ["ok-1", "failed-2:boom", "ok-3"]);
	});
});

// ---------------------------------------------------------------------------
// Parallel agent execution via runSync
// ---------------------------------------------------------------------------

describe("parallel agent execution", { skip: !piAvailable ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir();
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	function makeExecutor(agents = [makeAgent("echo")]) {
		return createSubagentExecutor({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents }),
		});
	}

	function readLastCallArgs(): string[] {
		const callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-"));
		assert.ok(callFile, "expected a recorded mock pi call");
		return JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
	}

	it("runs multiple agents concurrently via mapConcurrent + runSync", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = makeAgentConfigs(["agent-a", "agent-b", "agent-c"]);
		const tasks = ["Task A", "Task B", "Task C"];

		const results = await mapConcurrent(
			tasks.map((task, i) => ({ agent: agents[i].name, task, index: i })),
			3,
			async ({ agent, task, index }: any) => {
				return runSync(tempDir, agents, agent, task, { index });
			},
		);

		assert.equal(results.length, 3);
		assert.ok(results.every((r: any) => r.exitCode === 0));
		assert.equal(results[0].agent, "agent-a");
		assert.equal(results[1].agent, "agent-b");
		assert.equal(results[2].agent, "agent-c");
	});

	// AC: subagent-parallel-recovery.failed-task-settles-as-partial-result
	it("one task fails in a batch — batch returns partial results with the failed task marked", async () => {
		// One child exits non-zero, one exits clean. Response claim order across
		// concurrent children is not fixed, so assert order-independently: exactly
		// one slot failed, one succeeded, and BOTH results are present.
		mockPi.onCall({ output: "good output", exitCode: 0 });
		mockPi.onCall({ stderr: "child boom", exitCode: 1 });
		const agents = makeAgentConfigs(["a", "b"]);

		const results = await mapSettled(
			[{ agent: "a" }, { agent: "b" }],
			2,
			async ({ agent }: any, i: number) => runSync(tempDir, agents, agent, "task", { index: i }),
			(error: unknown, item: any, i: number) => buildFailedSingleResult(item.agent, "task", error, i),
		);

		assert.equal(results.length, 2, "both task results are returned (partial results)");
		const failed = results.filter((r: any) => r.exitCode !== 0);
		const succeeded = results.filter((r: any) => r.exitCode === 0);
		assert.equal(failed.length, 1, "exactly one task is marked failed");
		assert.equal(succeeded.length, 1, "the successful sibling is preserved");
		assert.ok(failed[0].error, "failed task carries an error");
		assert.deepEqual(results.map((r: any) => r.agent).sort(), ["a", "b"]);
	});

	// AC: subagent-parallel-recovery.failed-task-settles-as-partial-result
	it("a throwing per-task run settles as a failed slot and preserves siblings", async () => {
		mockPi.onCall({ output: "ok", exitCode: 0 });
		const agents = makeAgentConfigs(["a"]);
		const results = await mapSettled(
			[{ agent: "a" }, { agent: "explode" }],
			2,
			async ({ agent }: any, i: number) => {
				if (agent === "explode") throw new Error("setup blew up");
				return runSync(tempDir, agents, agent, "task", { index: i });
			},
			(error: unknown, item: any, i: number) => buildFailedSingleResult(item.agent, "task", error, i),
		);
		assert.equal(results.length, 2);
		assert.equal(results[0].exitCode, 0, "sibling preserved");
		assert.equal(results[1].exitCode, 1, "throwing slot settled as failed");
		assert.match(results[1].error, /setup blew up/);
		assert.equal(results[1].progress?.status, "failed");
	});

	// AC: subagent-parallel-recovery.error-terminal-message-settles-promptly
	it("a child that emits an error-terminal then holds open settles via the drain, not a hang", async () => {
		const errorTerminal = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "failing turn" }],
				model: "mock/test-model",
				errorMessage: "model exploded",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
			},
		};
		// Child reports an error-terminal and then never exits on its own; with
		// Layer 2 the existing bounded drain arms and force-terminates, so the run
		// settles with the error surfaced instead of hanging until 'close'.
		mockPi.onCall({ jsonl: [errorTerminal], holdOpen: true });
		const agents = makeAgentConfigs(["a"]);
		const result = await withTimeout(
			runSync(tempDir, agents, "a", "task", { index: 0 }),
			20000,
			"runSync did not settle after error-terminal",
		);
		assert.match(result.error ?? "", /model exploded/);
	});

	// AC: subagent-parallel-recovery.abort-propagates-to-process-group
	// AC: subagent-parallel-recovery.no-liveness-or-wedge-timeout
	// (the held-open child never self-terminates on any clock; only the
	//  caller-driven abort reaps it — recovery is cancel-driven, not timer-driven)
	it("aborting a running task reaps the child process group (incl grandchild) and settles", { skip: process.platform === "win32" ? "POSIX process groups only" : undefined }, async () => {
		const gcPidFile = path.join(tempDir, "grandchild.pid");
		mockPi.onCall({ grandchildPidFile: gcPidFile, holdOpen: true });
		const agents = makeAgentConfigs(["a"]);
		const controller = new AbortController();

		const runPromise = runSync(tempDir, agents, "a", "long running task", { index: 0, signal: controller.signal });

		const gcPid = await waitFor(() => {
			if (!fs.existsSync(gcPidFile)) return undefined;
			const raw = fs.readFileSync(gcPidFile, "utf-8").trim();
			return raw ? Number(raw) : undefined;
		}, 10000, "grandchild pid file");
		assert.ok(isAlive(gcPid), "grandchild should be running before abort");

		controller.abort();

		const result = await withTimeout(runPromise, 20000, "runSync did not settle after abort");
		assert.notEqual(result.exitCode, 0, "aborted run settles as non-success");

		// Group-targeted kill reaps the grandchild; a direct-child-only kill would
		// leave it alive. This is the regression guard for Constitution III.
		await waitFor(() => (!isAlive(gcPid) ? true : undefined), 10000, "grandchild to be reaped");
		assert.equal(isAlive(gcPid), false, "grandchild must be dead after process-group abort");
	});

	it("all agents get independent results", async () => {
		mockPi.onCall({ output: "Result" });
		const agents = makeAgentConfigs(["a", "b"]);

		const results = await mapConcurrent(
			[
				{ agent: "a", task: "Task A" },
				{ agent: "b", task: "Task B" },
			],
			2,
			async ({ agent, task }: any, i: number) => runSync(tempDir, agents, agent, task, { index: i }),
		);

		assert.equal(results.length, 2);
		assert.equal(results[0].agent, "a");
		assert.equal(results[1].agent, "b");
		const ok = results.filter((r: any) => r.exitCode === 0).length;
		assert.equal(ok, 2);
	});

	it("top-level parallel output saves use per-task output paths", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Saved report" });
		const executor = makeExecutor();

		const result = await executor.execute(
			"parallel-output",
			{ tasks: [{ agent: "echo", task: "Write report", output: "parallel-output.md" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const outputPath = path.join(tempDir, "parallel-output.md");
		assert.equal(result.isError, undefined);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "Saved report");
		assert.equal(result.details?.results?.[0]?.savedOutputPath, outputPath);
	});

	it("rejects duplicate top-level parallel output paths", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor();

		const result = await executor.execute(
			"parallel-duplicate-output",
			{
				tasks: [
					{ agent: "echo", task: "Write A", output: "same.md" },
					{ agent: "echo", task: "Write B", output: "same.md" },
				],
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /same path/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("top-level parallel reads are injected once with chain-style prefix", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Read done" });
		const executor = makeExecutor();

		await executor.execute(
			"parallel-reads",
			{ tasks: [{ agent: "echo", task: "Inspect", reads: ["a.md", "b.md"] }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const args = readLastCallArgs();
		assert.equal(args.at(-1), `Task: [Read from: ${path.join(tempDir, "a.md")}, ${path.join(tempDir, "b.md")}]

Inspect`);
	});

	it("top-level parallel progress emits the existing progress instruction style", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Progress done" });
		const executor = makeExecutor();

		await executor.execute(
			"parallel-progress",
			{ tasks: [{ agent: "echo", task: "Track work", progress: true }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const args = readLastCallArgs();
		assert.ok((args.at(-1) ?? "").includes(`Update progress at: ${path.join(tempDir, "progress.md")}`));
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), true);
	});
});
