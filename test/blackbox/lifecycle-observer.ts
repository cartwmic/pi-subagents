// Observe lifecycle and optionally retain stdio/teardown for cleanup tests.
// No compaction, continuation, or provider substitution.
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	const root = process.env.HEADLESS_COMPACTION_PROOF_DIR;
	if (!root || process.env.PI_SUBAGENT_CHILD !== "1") return;
	if (process.env.HEADLESS_COMPACTION_PROOF_LINGER === "1") {
		pi.on("session_start", () => {
			// Deliberately retain the child's stdout after Pi exits. The Python
			// fixture owns and reaps this helper; it never performs agent work.
			const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
				stdio: ["ignore", process.stdout, "ignore"],
			});
			holder.unref();
			appendFileSync(join(root, "stdio-holder.json"), JSON.stringify({ pid: holder.pid }));
		});
	}
	for (const type of ["session_start", "agent_start", "agent_end", "agent_settled", "session_before_compact", "session_compact", "session_compact_failed", "session_shutdown"] as const) {
		pi.on(type, (event, ctx) => {
			appendFileSync(join(root, "child-lifecycle.jsonl"), JSON.stringify({
				type, at: Date.now(), mode: ctx.mode,
				...(type === "session_start" ? { argv: process.argv, pid: process.pid, sessionFile: ctx.sessionManager.getSessionFile() } : {}),
				...("reason" in event ? { reason: event.reason } : {}),
			}) + "\n");
		});
	}
	if (process.env.HEADLESS_COMPACTION_PROOF_SHUTDOWN_LINGER === "1") {
		pi.on("session_shutdown", () => {
			// Exercise both terminal cleanup stages after real final compaction.
			process.on("SIGTERM", () => {});
			return new Promise<void>(() => { setInterval(() => {}, 1000); });
		});
	}
}
