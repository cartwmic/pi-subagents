import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeAgentConfigs, events } from "../support/helpers.ts";
import { installSingleExecutionHooks, tempDir, mockPi, runSync, getFinalOutput } from "../support/single-execution-fixture.ts";

// Port of 0fe2a797's event-order regression to upstream's SDK child factory.
describe("fork child lifecycle regressions", () => {
	installSingleExecutionHooks();
	for (const resume of [true, false]) {
		it(`preserves slow compaction and ${resume ? "continuation" : "final-stop cleanup"}`, async () => {
			mockPi.onCall({ steps: [
				{ jsonl: [events.assistantMessage("before compaction"), { type: "agent_settled" }, { type: "compaction_start", reason: "manual" }] },
				{ delay: 1400, jsonl: [{ type: "agent_settled" }] },
				{ delay: 1400, jsonl: [{ type: "compaction_end", reason: "manual" }, ...(resume ? [{ type: "agent_start" }, { type: "turn_start" }] : [])] },
				...(resume ? [{ delay: 1400, jsonl: [events.assistantMessage("after compaction"), { type: "agent_settled" }] }] : []),
			], keepAliveAfterFinalMessageMs: 10000 });
			const start = Date.now();
			const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Compact and continue", { acceptance: false });
			assert.equal(result.exitCode, 0);
			assert.equal(getFinalOutput(result.messages), resume ? "after compaction" : "before compaction");
			assert.ok(Date.now() - start >= (resume ? 4000 : 2600), "must finish extension work");
			assert.ok(Date.now() - start < 9000, "must retain bounded lingering-child cleanup");
		});
	}
});
