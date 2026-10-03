import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import { events, makeAgent } from "../support/helpers.ts";
import { SUBAGENT_PROCESS_TERMINAL_EVENT, SUBAGENT_ASYNC_STARTED_EVENT } from "../../src/shared/types.ts";
import { installAsyncExecutionHooks, tempDir, mockPi, launchProtocolTest, readAsyncPayload, executeAsyncSingle, executeAsyncChain } from "../support/async-execution-fixture.ts";

// Behavioral ports of the original fork regressions, using upstream's SDK runner.
describe("fork async lifecycle regressions", () => {
	installAsyncExecutionHooks();
	for (const resume of [true, false]) {
		it(`preserves slow compaction and ${resume ? "continuation" : "final-stop cleanup"}`, async () => {
			mockPi.onCall({ steps: [
				{ jsonl: [events.assistantMessage("before compaction"), { type: "agent_settled" }, { type: "compaction_start", reason: "manual" }] },
				{ delay: 1400, jsonl: [{ type: "agent_settled" }] },
				{ delay: 1400, jsonl: [{ type: "compaction_end", reason: "manual" }, ...(resume ? [{ type: "agent_start" }, { type: "turn_start" }] : [])] },
				...(resume ? [{ delay: 1400, jsonl: [events.assistantMessage("after compaction"), { type: "agent_settled" }] }] : []),
			], keepAliveAfterFinalMessageMs: 10000 });
			const start = Date.now();
			const id = `fork-compaction-${resume}-${start}`;
			launchProtocolTest(id);
			const payload = await readAsyncPayload(id);
			assert.equal(payload.success, true);
			assert.equal(payload.results[0]?.output, resume ? "after compaction" : "before compaction");
			assert.ok(Date.now() - start >= (resume ? 4000 : 2600), "must finish extension work");
			assert.ok(Date.now() - start < 9000, "must retain bounded lingering-child cleanup");
		});
	}
	for (const mode of ["single", "chain"] as const) {
		it(`survives a stale launching session when the async ${mode} child exits`, async () => {
			mockPi.onCall({ delay: 300, output: "stale-safe done" });
			const id = `fork-stale-${mode}-${Date.now()}`;
			let stale = false;
			const emitted: string[] = [];
			const staleEmits: string[] = [];
			const ctx = {
				pi: { events: { emit(name: string) {
					if (stale) {
						staleEmits.push(name);
						throw new Error("This extension ctx is stale after session replacement or reload.");
					}
					emitted.push(name);
				} } }, cwd: tempDir, currentSessionId: "session-1",
			};
			const common = { ctx, artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 }, shareEnabled: false, maxSubagentDepth: 2 };
			const result = await (mode === "single"
				? executeAsyncSingle(id, { ...common, agent: "worker", task: "Finish after reload", agentConfig: makeAgent("worker", { completionGuard: false }), sessionRoot: path.join(tempDir, "sessions"), acceptance: false })
				: executeAsyncChain(id, { ...common, chain: [{ agent: "worker", task: "Finish after reload" }], agents: [makeAgent("worker", { completionGuard: false })] }));
			assert.notEqual(result.isError, true);
			assert.ok(emitted.includes(SUBAGENT_ASYNC_STARTED_EVENT));
			stale = true;
			const payload = await readAsyncPayload(id);
			assert.equal(payload.success, true);
			const deadline = Date.now() + 10000;
			while (!staleEmits.includes(SUBAGENT_PROCESS_TERMINAL_EVENT) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
			assert.ok(staleEmits.includes(SUBAGENT_PROCESS_TERMINAL_EVENT));
			// An uncaught close-handler exception would fail this test process.
			await new Promise(resolve => setTimeout(resolve, 100));
		});
	}
});
