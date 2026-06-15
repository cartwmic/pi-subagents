import type { ChildProcess } from "node:child_process";

interface PostExitStdioGuardOptions {
	idleMs: number;
	hardMs: number;
}

interface ChildWithPipedStdio {
	stdout: ChildProcess["stdout"];
	stderr: ChildProcess["stderr"];
	on: ChildProcess["on"];
}

interface ChildWithKill {
	kill(signal?: NodeJS.Signals | number): boolean;
}

export function trySignalChild(child: ChildWithKill, signal: NodeJS.Signals): boolean {
	try {
		return child.kill(signal);
	} catch {
		return false;
	}
}

/**
 * Signal a child's entire PROCESS GROUP so the child AND its descendant
 * processes (e.g. a `claude-p` grandchild) receive the signal
 * (Constitution III). Requires the child to have been spawned detached
 * (its own group leader) so its pgid equals its pid; a negative pid then
 * targets the whole group.
 *
 * Falls back to signalling the direct child when group signalling is
 * unavailable (Windows, missing pid, or a thrown ESRCH/EPERM), so
 * termination still progresses (spec: "Group signalling is unavailable").
 */
export function killChildGroup(
	child: ChildWithKill & { pid?: number },
	signal: NodeJS.Signals,
): boolean {
	const pid = child.pid;
	if (typeof pid === "number" && pid > 0 && process.platform !== "win32") {
		try {
			process.kill(-pid, signal);
			return true;
		} catch {
			// Group gone or not a group leader — fall back to the direct child.
		}
	}
	return trySignalChild(child, signal);
}

export function attachPostExitStdioGuard(
	child: ChildWithPipedStdio,
	options: PostExitStdioGuardOptions,
): () => void {
	const { idleMs, hardMs } = options;
	let exited = false;
	let stdoutEnded = false;
	let stderrEnded = false;
	let idleTimer: NodeJS.Timeout | undefined;
	let hardTimer: NodeJS.Timeout | undefined;

	const destroyUnendedStdio = () => {
		if (!stdoutEnded) {
			try { child.stdout?.destroy(); } catch {}
		}
		if (!stderrEnded) {
			try { child.stderr?.destroy(); } catch {}
		}
	};

	const clearTimers = () => {
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = undefined;
		}
		if (hardTimer) {
			clearTimeout(hardTimer);
			hardTimer = undefined;
		}
	};

	const armIdleTimer = () => {
		if (!exited) return;
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(destroyUnendedStdio, idleMs);
		idleTimer.unref?.();
	};

	child.stdout?.on("data", armIdleTimer);
	child.stderr?.on("data", armIdleTimer);
	child.stdout?.on("end", () => {
		stdoutEnded = true;
		if (stdoutEnded && stderrEnded) clearTimers();
	});
	child.stderr?.on("end", () => {
		stderrEnded = true;
		if (stdoutEnded && stderrEnded) clearTimers();
	});
	child.on("exit", () => {
		exited = true;
		armIdleTimer();
		if (hardTimer) return;
		hardTimer = setTimeout(destroyUnendedStdio, hardMs);
		hardTimer.unref?.();
	});
	child.on("close", clearTimers);
	child.on("error", clearTimers);

	return clearTimers;
}
