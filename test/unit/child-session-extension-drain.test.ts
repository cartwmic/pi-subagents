import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefaultChildSessionFactory, childSessionExtensionDrainHeld, type PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";

async function childWithHost(waitForExtensionTasks?: () => Promise<void>) {
	const calls: string[] = [];
	// SAFETY: this scripted SDK implements the exact factory operations exercised
	// below; no model, tools, provider registrations or external I/O are requested.
	// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Deliberately partial SDK test double.
	const pi = {
		ModelRuntime: { create: async () => ({}) },
		SettingsManager: { create: () => ({ getTheme: () => ({}) }) },
		DefaultResourceLoader: class { async reload() {} },
		SessionManager: { inMemory: () => ({}) },
		createAgentSession: async () => ({ session: {
			bindExtensions: async () => {},
			prompt: async () => { calls.push("prompt"); },
			dispose: () => { calls.push("dispose"); },
			waitForExtensionTasks,
		} }),
	} as unknown as PiCodingAgentModule;
	const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
	const child = await factory.create({ cwd: process.cwd(), storage: { kind: "memory" }, extensionPaths: [], ambientExtensions: false, hooks: [], noSkills: true, noContextFiles: true, runtime: { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false } });
	return { child, calls, factory };
}

test("holds final drain until host-owned extension work completes before disposal", async () => {
	let finish!: () => void;
	const pending = new Promise<void>(resolve => { finish = resolve; });
	let waited = false;
	const { child, calls } = await childWithHost(async () => { waited = true; await pending; });
	let completed = false;
	const prompt = child.prompt("task").then(() => { completed = true; });
	await Promise.resolve();
	assert.equal(waited, true);
	assert.equal(completed, false);
	assert.equal(childSessionExtensionDrainHeld(child), true);
	assert.deepEqual(calls, ["prompt"]);
	finish();
	await prompt;
	assert.equal(childSessionExtensionDrainHeld(child), false);
	await child.dispose();
	assert.deepEqual(calls, ["prompt", "dispose"]);
});

test("unpatched hosts retain upstream prompt settlement without holding final drain", async () => {
	const { child, calls } = await childWithHost();
	await child.prompt("task");
	assert.equal(childSessionExtensionDrainHeld(child), false);
	await child.dispose();
	assert.deepEqual(calls, ["prompt", "dispose"]);
});

test("host extension-drain failures reject completion and clear the hold", async () => {
	const { child } = await childWithHost(async () => { throw new Error("extension failed"); });
	await assert.rejects(child.prompt("task"), /extension failed/);
	assert.equal(childSessionExtensionDrainHeld(child), false);
	await child.dispose();
});
