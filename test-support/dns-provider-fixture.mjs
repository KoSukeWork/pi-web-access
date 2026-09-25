import { getEventListeners } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

// Runs in the isolated home supplied by the parent. No network or credentials are read.
const [provider, trigger] = process.argv.slice(2);
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "web-search.json"), JSON.stringify({
	fetchRouting: { providers: ["jina"], allowRemoteHostedProviders: true },
}));
let requests = 0, lookups = 0;
const transport = async () => { requests++; throw new Error("unexpected network request"); };
createRequire(import.meta.url)("undici").fetch = transport;
globalThis.fetch = transport;
const extract = provider === "jina" ? (await import("../extract.ts")).extractContent
	: provider === "firecrawl" ? (await import("../firecrawl.ts")).extractWithFirecrawl
	: provider === "brightdata" ? (await import("../brightdata-unlocker.ts")).extractWithBrightDataUnlocker
	: provider === "kagi" ? (await import("../kagi.ts")).extractWithKagi
	: (await import("../ollama.ts")).extractWithOllama;
const controller = new AbortController();
const entered = Promise.withResolvers(), gate = Promise.withResolvers();
const pending = extract("https://dns.provider.test/page", controller.signal, {
	timeoutMs: trigger === "timeout" && provider !== "jina" ? 50 : 5000,
	lookup: async () => {
		if (++lookups === (provider === "jina" ? 2 : 1)) { entered.resolve(); await gate.promise; }
		return [{ address: "93.184.216.34", family: 4 }];
	},
}).then(result => result?.error ?? null, error => error.message);
await entered.promise;
let timer, deadline, settledBeforeDns, error;
if (trigger === "cancel") controller.abort();
else if (provider === "jina") deadline = setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), 20);
try {
	settledBeforeDns = await Promise.race([
		pending.then(() => true),
		new Promise(resolve => { timer = setTimeout(() => resolve(false), 300); }),
	]);
} finally {
	clearTimeout(timer);
	clearTimeout(deadline);
	gate.resolve();
	error = await pending;
}
console.log(JSON.stringify({ settledBeforeDns, requests, lookups, error,
	abortListeners: getEventListeners(controller.signal, "abort").length }));
