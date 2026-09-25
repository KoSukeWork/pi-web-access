import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

function run(provider, scenario) {
	const home = mkdtempSync(join(tmpdir(), "pi-remote-fetch-"));
	try {
		const child = spawnSync(process.execPath, [fileURLToPath(new URL("../test-support/remote-fetch-fixture.mjs", import.meta.url)), provider, scenario], {
			encoding: "utf8", timeout: 30_000, windowsHide: true,
			env: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home, XDG_CONFIG_HOME: home,
				FIRECRAWL_BASE_URL: "https://firecrawl.fetch.test", FIRECRAWL_API_KEY: "fixture-key", FIRECRAWL_API_VERSION: "v2",
				BRIGHTDATA_API_KEY: "fixture-key", BRIGHTDATA_UNLOCKER_ZONE: "fixture-zone" },
		});
		assert.equal(child.status, 0, child.stderr || String(child.error));
		return JSON.parse(child.stdout.trim());
	} finally {
		assert.equal(dirname(resolve(home)), resolve(tmpdir()));
		rmSync(home, { recursive: true, force: true });
	}
}

for (const provider of ["auth", "firecrawl", "brightdata"]) {
	if (provider !== "auth") {
		for (const status of [301, 302, 303, 308]) {
			test(`${provider}: retain the API POST payload across ${status} redirects`, () => {
				const output = run(provider, `status-${status}`);
				assert.equal(output.error, null);
				assert.deepEqual(output.calls.map(call => call.method), ["POST", "POST"]);
				assert.equal(output.calls[1].body, output.calls[0].body);
				assert.deepEqual(output.cancelled, [output.calls[0].url]);
			});
		}
	}
	test(`${provider}: connect using validated DNS addresses on every hop`, () => {
		const output = run(provider, "redirect");
		assert.equal(output.error, null);
		assert.equal(output.result.content, "fixture body");
		assert.equal(output.calls.length, 2);
		assert.deepEqual(output.calls.map(call => call.address), ["93.184.216.34", "93.184.216.34"]);
		assert.ok(output.calls.every(call => call.redirect === "manual"));
		if (provider === "auth") {
			assert.deepEqual(output.cookies, ["/start", "/next"]);
			assert.deepEqual(output.calls.map(call => call.headers.cookie), ["fixture=/start", "fixture=/next"]);
		} else {
			assert.deepEqual(output.calls.map(call => call.method), ["POST", "POST"]);
			assert.equal(output.calls[1].body, output.calls[0].body);
		}
	});
	for (const scenario of ["direct", "redirect", "private", "invalid", "loop", "cross-origin"]) {
		test(`${provider}: release discarded redirect bodies (${scenario})`, () => {
			const output = run(provider, scenario);
			const refused = ["private", "invalid", "loop"].includes(scenario) || (provider === "auth" && scenario === "cross-origin");
			if (refused) assert.ok(output.error, "expected the redirect to be refused");
			else assert.equal(output.error, null);
			const expected = scenario === "direct" ? [] : output.calls.slice(0, refused ? undefined : -1).map(call => call.url);
			assert.deepEqual(output.cancelled, expected);
			if (scenario === "loop") assert.equal(output.calls.length, 6);
			if (scenario === "private" || scenario === "invalid" || (provider === "auth" && scenario === "cross-origin")) assert.equal(output.calls.length, 1);
			if (scenario === "cross-origin" && provider !== "auth") {
				assert.equal(output.calls[0].headers.authorization, "Bearer fixture-key");
				assert.equal(output.calls[1].headers.authorization, undefined);
				assert.equal(output.calls[1].address, "93.184.216.35");
			}
		});
	}
}

test("auth: release the previous response when the next cookie lookup fails", () => {
	const output = run("auth", "cookie-error");
	assert.match(output.error, /cookie fixture failed/);
	assert.equal(output.calls.length, 1);
	assert.deepEqual(output.cancelled, [output.calls[0].url]);
});
