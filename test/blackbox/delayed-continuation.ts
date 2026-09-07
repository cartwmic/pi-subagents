// Model an async input integration (e.g. context lookup) before Pi starts the
// continuation. Do not initiate compaction, send prompts, or replace providers.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	const root = process.env.HEADLESS_COMPACTION_PROOF_DIR;
	const delay = Number(process.env.HEADLESS_COMPACTION_PROOF_START_DELAY_MS);
	if (!root || process.env.PI_SUBAGENT_CHILD !== "1" || !(delay > 0)) return;
	pi.on("input", async (event) => {
		if (event.source !== "extension") return;
		const record = (type: string) => appendFileSync(join(root, "continuation-preflight.jsonl"), JSON.stringify({ type, at: Date.now() }) + "\n");
		// Ordinary diagnostics need not end with a newline. Teardown protocol
		// must still be recognized after this pending input finishes or aborts.
		process.stderr.write("fixture continuation preflight");
		record("input-start");
		await new Promise((resolve) => setTimeout(resolve, delay));
		record("input-end");
		return { action: "continue" };
	});
}
