import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

function run(kind, mode, scenario) {
	const home = mkdtempSync(join(tmpdir(), "pi-extract-lifecycle-"));
	try {
		const child = spawnSync(process.execPath, [fileURLToPath(new URL("../test-support/extract-lifecycle-fixture.mjs", import.meta.url)), kind, mode, scenario], {
			encoding: "utf8", timeout: 30_000, windowsHide: true,
			env: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, "agent"), XDG_CONFIG_HOME: home },
		});
		assert.equal(child.status, 0, child.stderr || String(child.error));
		const output = JSON.parse(child.stdout.trim());
		assert.equal(output.abortListeners, 0, "release the caller's abort listener after completion");
		return output;
	} finally {
		assert.equal(dirname(resolve(home)), resolve(tmpdir()));
		assert.ok(home.startsWith(join(tmpdir(), "pi-extract-lifecycle-")));
		rmSync(home, { recursive: true, force: true });
	}
}

for (const mode of ["raw", "auth"]) {
	for (const phase of ["initial-dns", "transport-dns", "redirect-dns"]) {
		for (const trigger of ["cancel", "timeout"]) {
			test(`${mode}: ${trigger} settles before pending ${phase} completes`, () => {
				const output = run("dns-pending", mode, `${trigger}:${phase}`);
				assert.equal(output.settledBeforeDns, true, "DNS must not hold up cancellation or the HTTP timeout");
				assert.match(output.result.error, /abort|timed out/i);
				assert.equal(output.requests, phase === "redirect-dns" ? 1 : 0);
				assert.equal(output.cookieReads, phase === "redirect-dns" && mode === "auth" ? 1 : 0);
				assert.equal(output.redirectCancels, phase === "redirect-dns" ? 1 : 0);
			});
		}
	}
	for (const phase of ["before-call", "initial-dns", "transport-dns"]) {
		test(`${mode}: cancellation during ${phase} prevents HTTP and Cookie access`, () => {
			const output = run("cancel", mode, phase);
			assert.equal(output.aborted, true);
			assert.equal(output.requests, 0, "do not send a request after cancellation");
			assert.equal(output.cookieReads, 0, "do not read browser cookies after cancellation");
			assert.match(output.result.error, /abort/i);
		});
	}
	test(`${mode}: an active signal allows a complete response`, () => {
		const output = run("cancel", mode, "none");
		assert.equal(output.aborted, false);
		assert.equal(output.requests, 1);
		assert.equal(output.cookieReads, mode === "auth" ? 1 : 0);
		assert.equal(output.result.error, null);
		assert.equal(output.result.content, "fixture body");
	});
}

test("auth: cancellation while preparing cookies prevents the request", () => {
	const output = run("cancel", "auth", "cookies");
	assert.equal(output.cookieReads, 1);
	assert.equal(output.requests, 0);
	assert.match(output.result.error, /abort/i);
});

for (const phase of ["initial-cookie", "redirect-cookie"]) {
	for (const action of ["cancel", "timeout"]) {
		test(`auth: ${action} settles before pending ${phase} completes`, () => {
			const output = run("cookie-pending", "auth", `${action}:${phase}`);
			assert.equal(output.settledBeforeCookie, true, "Cookie lookup must not hold up cancellation or the HTTP timeout");
			assert.match(output.result.error, /abort|timed out/i);
			assert.equal(output.cookieReads, phase === "initial-cookie" ? 1 : 2);
			assert.equal(output.requests, phase === "initial-cookie" ? 0 : 1);
			assert.equal(output.redirectCancels, phase === "initial-cookie" ? 0 : 1);
		});
	}
}

const cleanupCases = [
	["declared-oversize", /Response too large/, "raw"],
	["raw-unsupported-type", /Unsupported content type in raw mode/, "raw"],
	["disabled-pdf", /PDF extraction is disabled/, "raw"],
	["http-error", /HTTP 503/, "readable"],
	["disabled-image", /Image fetching is disabled/, "readable"],
	["unsupported-readable", /Unsupported content type/, "readable"],
	["config-error", /Failed to parse/, "raw"],
	["streamed-oversize", /Response too large/, "raw"],
	["abort-reading", /abort/i, "raw"],
	["timeout-reading", /abort/i, "raw"],
	["successful-body", null, "raw"],
	["empty-body", null, "raw"],
];

for (const [scenario, error, mode] of cleanupCases) {
	test(`final HTTP response is released: ${scenario}`, () => {
		const output = run("cleanup", mode, scenario);
		assert.equal(output.requests, 1);
		if (error) assert.match(output.result.error, error);
		else {
			assert.equal(output.result.error, null);
			assert.equal(output.result.content, scenario === "empty-body" ? "" : "finished");
		}
		assert.equal(output.bodyClosed, true, "the response must finish or be cancelled when extraction returns");
	});
}

test("body cancellation failure preserves the original extraction error", () => {
	const output = run("cancel-error", "raw", "none");
	assert.equal(output.cancelCalls, 1);
	assert.match(output.result.error, /Unsupported content type in raw mode/);
});
