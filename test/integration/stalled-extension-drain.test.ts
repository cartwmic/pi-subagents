import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { runChildSession } from "../../src/runs/background/run-child-session.ts";
import { childSessionExtensionDrainHeld, createDefaultChildSessionFactory, type ChildSession, type PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";
import type { InProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import { createTempDir, makeAgentConfigs, removeTempDir } from "../support/helpers.ts";

// Exercise the real SDK adapter, not a fake ChildSession.prompt: the host prompt
// ends successfully but its optional extension-task callback never resolves.
function stalledHost() {
	const calls: string[] = [];
	let listener: Parameters<ChildSession["subscribe"]>[0] = () => {};
	const messages = [fauxAssistantMessage("before stalled callback")];
	let entered!: () => void;
	const waiting = new Promise<void>((resolve) => { entered = resolve; });
	// SAFETY: the scripted SDK implements only the factory operations needed by
	// these runs; no real provider, model or extension I/O is performed.
	// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Partial SDK test double.
	const pi = {
		ModelRuntime: { create: async () => ({}) },
		SettingsManager: { create: () => ({ getTheme: () => ({}) }) },
		DefaultResourceLoader: class {
			async reload() {}
			getExtensions() { return { errors: [], runtime: {} }; }
		},
		SessionManager: { inMemory: () => ({}), create: () => ({}) },
		resolveCliModel: () => ({}),
		createAgentSession: async () => ({ session: {
			bindExtensions: async () => {},
			subscribe(next: typeof listener) { listener = next; return () => { calls.push("unsubscribe"); }; },
			async prompt() {
				calls.push("prompt");
				listener({ type: "message_end", message: messages[0] });
				listener({ type: "agent_settled" });
			},
			waitForExtensionTasks() {
				calls.push("wait");
				entered();
				return new Promise<void>(() => {});
			},
			async abort() { calls.push("abort"); },
			async steer() {}, async followUp() {},
			extensionRunner: {
				hasHandlers: (event: string) => event === "session_shutdown",
				async emit(event: { type: string }) { calls.push(event.type); },
			},
			dispose() { calls.push("dispose"); },
			messages, sessionId: "stalled-host",
		} }),
	} as unknown as PiCodingAgentModule;
	const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
	let child: ChildSession | undefined;
	return {
		calls, waiting,
		get child() { return child; },
		factory: {
			async create(launch: Parameters<typeof factory.create>[0]) { child = await factory.create(launch); return child; },
			dispose: () => factory.dispose(),
		},
	};
}

for (const mode of ["foreground timeout", "foreground abort", "background stop"] as const) {
	test(`${mode} fails boundedly and shuts down a stalled host extension wait`, { timeout: 10_000 }, async () => {
		const cwd = createTempDir("stalled-extension-drain-");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = path.join(cwd, "agent");
		fs.mkdirSync(process.env.PI_CODING_AGENT_DIR);
		const host = stalledHost();
		const controller = new AbortController();
		let stop: (() => void) | undefined;
		// SAFETY: runChildSession consumes only session here; the scripted SDK
		// emits no tool or capture events, as in run-child-session.test.ts.
		const launch = { session: {
			cwd, storage: { kind: "memory" }, extensionPaths: [], ambientExtensions: false,
			hooks: [], noSkills: true, noContextFiles: true,
			runtime: { fanoutChild: false, fast: false, depth: 1, waitTool: { enabled: false } },
		} } as InProcessChildLaunch;
		let deadline: ReturnType<typeof setTimeout> | undefined;
		try {
			const started = Date.now();
			const run = mode === "background stop"
				? runChildSession({ factory: host.factory, launch, prompt: "Finish", appendChildEvent() {}, writeOutputLine() {}, registerStop(handler) { stop = handler; } })
				: runSync(cwd, makeAgentConfigs(["worker"]), "worker", "Finish", {
					childSessionFactory: host.factory, acceptance: false,
					...(mode === "foreground timeout" ? { timeoutMs: 1000 } : { signal: controller.signal }),
				});
			const bounded = <T>(promise: Promise<T>) => Promise.race([promise, new Promise<never>((_, reject) => {
				deadline = setTimeout(() => reject(new Error(`${mode} did not finish within 7s`)), 7000);
			})]);
			await bounded(host.waiting);
			clearTimeout(deadline);
			assert.equal(childSessionExtensionDrainHeld(host.child), true, "cancel during the real adapter's extension drain hold");
			assert.deepEqual(host.calls, ["prompt", "wait"]);
			if (mode === "foreground abort") controller.abort();
			if (mode === "background stop") { assert.ok(stop); stop(); }
			const result = await bounded(run);
			assert.equal(result.exitCode, 1, "must not accept the preceding assistant stop as success");
			if (mode === "foreground timeout") {
				assert.equal(result.timedOut, true);
				assert.match(result.error ?? "", /timed out after 1000ms/);
			} else if (mode === "background stop") {
				assert.equal(result.stopped, true);
				assert.equal(result.error, "Subagent stopped by user.");
			} else {
				assert.match(result.error ?? "", /stopped before completion/i);
			}
			assert.ok(Date.now() - started < 7000, "bounded failure includes completed shutdown");
			assert.deepEqual(host.calls, ["prompt", "wait", "abort", "unsubscribe", "session_shutdown", "dispose"]);
		} finally {
			clearTimeout(deadline);
			await host.factory.dispose();
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			removeTempDir(cwd);
		}
	});
}
