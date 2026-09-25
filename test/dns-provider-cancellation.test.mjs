import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

for (const provider of ["firecrawl", "brightdata", "kagi", "ollama", "jina"]) {
	for (const trigger of ["cancel", "timeout"]) {
		test(`${provider}: ${trigger} ends target DNS validation before the resolver finishes`, () => {
			const home = mkdtempSync(join(tmpdir(), "pi-provider-dns-"));
			try {
				const child = spawnSync(process.execPath, [
					fileURLToPath(new URL("../test-support/dns-provider-fixture.mjs", import.meta.url)), provider, trigger,
				], {
					encoding: "utf8", windowsHide: true, timeout: 30000,
					env: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, "agent"), XDG_CONFIG_HOME: home,
						FIRECRAWL_BASE_URL: "https://firecrawl.provider.test", FIRECRAWL_API_KEY: "fixture-key", FIRECRAWL_API_VERSION: "v2",
						BRIGHTDATA_API_KEY: "fixture-key", BRIGHTDATA_UNLOCKER_ZONE: "fixture-zone" },
				});
				assert.equal(child.status, 0, child.stderr || String(child.error));
				const output = JSON.parse(child.stdout.trim());
				assert.equal(output.settledBeforeDns, true);
				assert.equal(output.requests, 0);
				assert.ok(output.error);
				assert.equal(output.abortListeners, 0);
			} finally {
				assert.equal(dirname(resolve(home)), resolve(tmpdir()));
				assert.ok(home.startsWith(join(tmpdir(), "pi-provider-dns-")));
				rmSync(home, { recursive: true, force: true });
			}
		});
	}
}
