import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

// Port fb691ac8's host-ownership regression to Pi 1.0.0. Upstream deliberately
// requires pi-ai >=0.86.1; that open-ended floor still admits the installed host.
test("host-provided packages remain optional peers compatible with Pi 1.0.0", () => {
	const manifest = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
	const lock = JSON.parse(fs.readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8")).packages[""];
	for (const name of ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
		assert.equal(manifest.dependencies?.[name], undefined, `${name} must come from the host`);
		assert.deepEqual(manifest.peerDependenciesMeta[name], { optional: true });
		const range = manifest.peerDependencies[name];
		assert.equal(range, name === "@earendil-works/pi-ai" ? ">=0.86.1" : "*");
		assert.equal(lock.peerDependencies[name], range);
		assert.equal(lock.dependencies?.[name], undefined);
	}
});
