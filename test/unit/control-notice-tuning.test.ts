/**
 * Unit tests for improve-control-notice-tuning Sections 13.1–13.5:
 *  - 13.1 default-threshold value bumped to 180_000
 *  - 13.2 resolveControlConfig coalesceWindowMs parsing matrix
 *  - 13.3 formatCoalescedControlNoticeMessage snapshot tests (N=1, N=3)
 *  - 13.4 hint replacement when no intercom is registered
 *  - 13.5 buildControlEvent populates lastActivityAt / elapsedMs correctly
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_COALESCE_WINDOW_MS,
	DEFAULT_CONTROL_CONFIG,
	buildControlEvent,
	controlNotificationKey,
	controlNotificationKeyFor,
	formatCoalescedControlNoticeMessage,
	formatControlNoticeMessage,
	resolveControlConfig,
} from "../../subagent-control.ts";
import type { ControlEvent } from "../../types.ts";

describe("13.1 default threshold bumped to 180s", () => {
	it("DEFAULT_CONTROL_CONFIG.needsAttentionAfterMs === 180_000", () => {
		assert.equal(DEFAULT_CONTROL_CONFIG.needsAttentionAfterMs, 180_000);
	});
});

describe("13.2 resolveControlConfig.coalesceWindowMs parsing", () => {
	it("default when nothing supplied", () => {
		const cfg = resolveControlConfig();
		assert.equal(cfg.coalesceWindowMs, DEFAULT_COALESCE_WINDOW_MS);
	});

	it("override > globalConfig > default", () => {
		const cfg = resolveControlConfig(
			{ coalesceWindowMs: 500 },
			{ coalesceWindowMs: 250 },
		);
		assert.equal(cfg.coalesceWindowMs, 250);
	});

	it("global is used when override is absent", () => {
		const cfg = resolveControlConfig({ coalesceWindowMs: 750 }, undefined);
		assert.equal(cfg.coalesceWindowMs, 750);
	});

	it("0 is preserved (disable coalescing)", () => {
		const cfg = resolveControlConfig(undefined, { coalesceWindowMs: 0 });
		assert.equal(cfg.coalesceWindowMs, 0);
	});

	it("negative falls back to default", () => {
		const cfg = resolveControlConfig(undefined, { coalesceWindowMs: -1 });
		assert.equal(cfg.coalesceWindowMs, DEFAULT_COALESCE_WINDOW_MS);
	});

	it("NaN falls back to default", () => {
		const cfg = resolveControlConfig(undefined, { coalesceWindowMs: Number.NaN });
		assert.equal(cfg.coalesceWindowMs, DEFAULT_COALESCE_WINDOW_MS);
	});

	it("non-integer falls back to default", () => {
		const cfg = resolveControlConfig(undefined, { coalesceWindowMs: 1.5 });
		assert.equal(cfg.coalesceWindowMs, DEFAULT_COALESCE_WINDOW_MS);
	});
});

describe("13.3 formatCoalescedControlNoticeMessage snapshots", () => {
	function makeEvent(overrides: Partial<ControlEvent> & {
		runId?: string;
		index?: number;
		agent?: string;
	} = {}): ControlEvent {
		return {
			type: "needs_attention",
			from: undefined,
			to: "needs_attention",
			ts: 1_000_000,
			runId: overrides.runId ?? "run-coalesced",
			agent: overrides.agent ?? "worker",
			index: overrides.index ?? 0,
			message: "stalled",
			lastActivityAt: 800_000,
			elapsedMs: 200_000,
		};
	}

	it("N=1 delegates to formatControlNoticeMessage (single-step compat)", () => {
		const event = makeEvent({ index: 0, agent: "solo" });
		const targets = new Map<number, string>([[0, "subagent-solo-1"]]);
		const single = formatControlNoticeMessage(event, "subagent-solo-1");
		const coalesced = formatCoalescedControlNoticeMessage([event], targets, 180_000);
		assert.equal(coalesced, single, "N=1 must return identical text to single-step");
	});

	it("N=3 produces multi-step bullets with elapsed seconds", () => {
		const events = [
			makeEvent({ index: 0, agent: "a" }),
			makeEvent({ index: 1, agent: "b" }),
			makeEvent({ index: 2, agent: "c" }),
		];
		const targets = new Map<number, string>([
			[0, "subagent-a-1"],
			[1, "subagent-b-2"],
			[2, "subagent-c-3"],
		]);
		const text = formatCoalescedControlNoticeMessage(events, targets, 180_000);
		assert.match(text, /Subagent needs attention: run run-coalesced/);
		assert.match(text, /3 steps stalled \(>~180s no activity\):/);
		assert.match(text, /- step 1 \(a\): no activity for 200s/);
		assert.match(text, /- step 2 \(b\): no activity for 200s/);
		assert.match(text, /- step 3 \(c\): no activity for 200s/);
		assert.match(text, /Status: subagent\(\{ action: "status", id: "run-coalesced" \}\)/);
		assert.match(text, /Interrupt: subagent\(\{ action: "interrupt", id: "run-coalesced" \}\)/);
		assert.match(text, /step 1: Nudge: intercom\(\{ action: "send", to: "subagent-a-1"/);
		assert.match(text, /step 2: Nudge: intercom\(\{ action: "send", to: "subagent-b-2"/);
		assert.match(text, /step 3: Nudge: intercom\(\{ action: "send", to: "subagent-c-3"/);
	});

	it("N=3 with NO intercom targets emits ONE Action: line and zero Nudge: lines", () => {
		const events = [
			makeEvent({ index: 0, agent: "a" }),
			makeEvent({ index: 1, agent: "b" }),
			makeEvent({ index: 2, agent: "c" }),
		];
		const text = formatCoalescedControlNoticeMessage(events, new Map(), 180_000);
		const actionLines = text.split("\n").filter((line) => line.startsWith("Action:"));
		const nudgeLines = text.split("\n").filter((line) => line.includes("Nudge:"));
		assert.equal(actionLines.length, 1, "exactly one Action: line");
		assert.equal(nudgeLines.length, 0, "zero Nudge: lines when no intercom targets");
		assert.match(text, /Action: this run has no intercom; if it's stuck, use Interrupt above\./);
	});

	it("threshold rendered from explicit thresholdMs argument", () => {
		const events = [makeEvent({ index: 0 }), makeEvent({ index: 1 })];
		const text = formatCoalescedControlNoticeMessage(events, new Map(), 60_000);
		assert.match(text, /\(>~60s no activity\)/);
	});
});

describe("13.4 hint replacement (no intercom)", () => {
	it("formatControlNoticeMessage emits Action line when childIntercomTarget is undefined", () => {
		const event: ControlEvent = {
			type: "needs_attention",
			from: undefined,
			to: "needs_attention",
			ts: 1_000_000,
			runId: "no-intercom",
			agent: "worker",
			message: "stalled",
		};
		const text = formatControlNoticeMessage(event, undefined);
		assert.match(text, /Action: this run has no intercom; if it's stuck, use Interrupt above\./);
		assert.doesNotMatch(text, /Nudge: no child message route registered/);
	});

	it("formatControlNoticeMessage keeps Nudge line when target is provided", () => {
		const event: ControlEvent = {
			type: "needs_attention",
			from: undefined,
			to: "needs_attention",
			ts: 1_000_000,
			runId: "with-intercom",
			agent: "worker",
			message: "stalled",
		};
		const text = formatControlNoticeMessage(event, "subagent-worker-1");
		assert.match(text, /Nudge: intercom\(\{ action: "send", to: "subagent-worker-1"/);
	});
});

describe("9b emitter-side recovery clear key parity", () => {
	// Regression test for Section 9b.1 / 9b.2: the recovery-clear key must
	// match exactly what `claimControlNotification` originally added to the
	// dedup set. If the formula drifts, recovery clears would no-op silently
	// and re-stalls would never re-emit — a false-negative that's hard to
	// detect at runtime.
	it("controlNotificationKeyFor matches controlNotificationKey for execution.ts call shape (no target)", () => {
		const event: ControlEvent = {
			type: "needs_attention",
			from: undefined,
			to: "needs_attention",
			ts: 1_000_000,
			runId: "exec-run",
			agent: "worker",
			index: 2,
			message: "stalled",
		};
		const originalKey = controlNotificationKey(event);
		const recoveryKey = controlNotificationKeyFor("exec-run", 2, "needs_attention");
		assert.equal(recoveryKey, originalKey);
	});

	it("controlNotificationKeyFor matches controlNotificationKey for subagent-runner.ts call shape (with target)", () => {
		const event: ControlEvent = {
			type: "needs_attention",
			from: undefined,
			to: "needs_attention",
			ts: 1_000_000,
			runId: "runner-run",
			agent: "worker",
			index: 0,
			message: "stalled",
		};
		const target = "subagent-worker-runner-run-1";
		const originalKey = controlNotificationKey(event, target);
		const recoveryKey = controlNotificationKeyFor(
			"runner-run",
			0,
			"needs_attention",
			target,
		);
		assert.equal(recoveryKey, originalKey);
	});

	it("undefined index produces same key shape", () => {
		const event: ControlEvent = {
			type: "needs_attention",
			from: undefined,
			to: "needs_attention",
			ts: 1_000_000,
			runId: "r",
			agent: "a",
			message: "",
		};
		const originalKey = controlNotificationKey(event);
		const recoveryKey = controlNotificationKeyFor("r", undefined, "needs_attention");
		assert.equal(recoveryKey, originalKey);
	});
});

describe("13.5 buildControlEvent populates lastActivityAt / elapsedMs", () => {
	it("populates lastActivityAt and elapsedMs when input.lastActivityAt is provided", () => {
		const event = buildControlEvent({
			to: "needs_attention",
			runId: "r",
			agent: "a",
			ts: 5_000,
			lastActivityAt: 1_500,
		});
		assert.equal(event.lastActivityAt, 1_500);
		assert.equal(event.elapsedMs, 3_500);
	});

	it("leaves lastActivityAt and elapsedMs undefined when input.lastActivityAt is absent", () => {
		const event = buildControlEvent({
			to: "needs_attention",
			runId: "r",
			agent: "a",
		});
		assert.equal(event.lastActivityAt, undefined);
		assert.equal(event.elapsedMs, undefined);
	});

	it("clamps elapsedMs at 0 when ts is somehow before lastActivityAt", () => {
		const event = buildControlEvent({
			to: "needs_attention",
			runId: "r",
			agent: "a",
			ts: 100,
			lastActivityAt: 1_000,
		});
		assert.equal(event.elapsedMs, 0);
	});
});
