import { getEventListeners, once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire, registerHooks } from "node:module";
import { join } from "node:path";

// The parent supplies an isolated home. Cookie access is always simulated;
// HTTP cleanup cases connect only to an explicitly allowed loopback server.
const [kind, mode, scenario] = process.argv.slice(2);
const controller = new AbortController();
const configPath = join(process.env.PI_CODING_AGENT_DIR, "web-search.json");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
writeFileSync(configPath, JSON.stringify({
	ssrf: { allowRanges: ["127.0.0.1/32"] }, fetchRouting: { providers: ["http"] },
	pdf: { enabled: false }, image: { enabled: false },
}));

let requests = 0, cookieReads = 0, lookups = 0, cancelCalls = 0, redirectCancels = 0;
const cookieUrl = new URL("../chrome-cookies.ts", import.meta.url).href;
globalThis.fixtureCookies = async () => {
	cookieReads++;
	if (scenario === "cookies") {
		await Promise.resolve();
		controller.abort();
	}
	return { cookieHeader: "fixture=cookie" };
};
registerHooks({
	load(url, context, nextLoad) {
		if (url !== cookieUrl) return nextLoad(url, context);
		return { format: "module", shortCircuit: true, source: `
			export const getBrowserCookiesForHosts = (...args) => globalThis.fixtureCookies(...args);
			export const getLastBrowserCookieDiagnostic = () => null;
			export const getGoogleCookies = async () => null;
			export const getLastGoogleCookieDiagnostic = () => null;
		` };
	},
});

if (kind !== "cleanup") {
	const transport = async (_url, init) => {
		init.signal?.throwIfAborted();
		requests++;
		if (((kind === "dns-pending" && scenario.endsWith(":redirect-dns")) ||
			(kind === "cookie-pending" && scenario.endsWith(":redirect-cookie"))) && requests === 1) {
			return new Response(new ReadableStream({ cancel() { redirectCancels++; } }), {
				status: 302, headers: { location: "/next" },
			});
		}
		if (kind === "cancel-error") {
			return new Response(new ReadableStream({
				cancel() { cancelCalls++; throw new Error("fixture cancellation failure"); },
			}), { headers: { "content-type": "application/octet-stream" } });
		}
		return new Response("fixture body", { headers: { "content-type": "text/plain" } });
	};
	createRequire(import.meta.url)("undici").fetch = transport;
	globalThis.fetch = transport;
}

const { extractContent } = await import("../extract.ts");
let result, bodyClosed, settledBeforeDns, settledBeforeCookie;
if (kind === "cookie-pending") {
	const [action, phase] = scenario.split(":");
	const entered = Promise.withResolvers(), gate = Promise.withResolvers();
	globalThis.fixtureCookies = async () => {
		if (++cookieReads === (phase === "initial-cookie" ? 1 : 2)) { entered.resolve(); await gate.promise; }
		return { cookieHeader: "fixture=cookie" };
	};
	const pending = extractContent("https://lifecycle.fetch.test/page", controller.signal, {
		mode: "raw", timeoutMs: action === "timeout" ? 50 : 5000,
		authFetchProfile: { name: "fixture", hosts: ["lifecycle.fetch.test"], redirects: "same-origin", cache: "off" },
		lookup: async () => [{ address: "93.184.216.34", family: 4 }],
	});
	await entered.promise;
	if (action === "cancel") controller.abort();
	let timer;
	try {
		settledBeforeCookie = await Promise.race([
			pending.then(() => true),
			new Promise(resolve => { timer = setTimeout(() => resolve(false), 300); }),
		]);
	} finally {
		clearTimeout(timer);
		gate.resolve();
		result = await pending;
	}
} else if (kind === "dns-pending") {
	const [action, phase] = scenario.split(":");
	const entered = Promise.withResolvers(), gate = Promise.withResolvers();
	const lookupIndex = phase === "initial-dns" ? 1 : phase === "transport-dns" ? 2 : 3;
	const pending = extractContent("https://lifecycle.fetch.test/page", controller.signal, {
		mode: "raw", timeoutMs: action === "timeout" ? 50 : 5000,
		...(mode === "auth" ? { authFetchProfile: { name: "fixture", hosts: ["lifecycle.fetch.test"], redirects: "same-origin", cache: "off" } } : {}),
		lookup: async () => {
			if (++lookups === lookupIndex) { entered.resolve(); await gate.promise; }
			return [{ address: "93.184.216.34", family: 4 }];
		},
	});
	await entered.promise;
	if (action === "cancel") controller.abort();
	let timer;
	try {
		settledBeforeDns = await Promise.race([
			pending.then(() => true),
			new Promise(resolve => { timer = setTimeout(() => resolve(false), 300); }),
		]);
	} finally {
		clearTimeout(timer);
		gate.resolve();
		result = await pending;
	}
} else if (kind !== "cleanup") {
	if (scenario === "before-call") controller.abort();
	result = await extractContent("https://lifecycle.fetch.test/page", controller.signal, {
		mode: "raw",
		...(mode === "auth" ? { authFetchProfile: { name: "fixture", hosts: ["lifecycle.fetch.test"], redirects: "same-origin", cache: "off" } } : {}),
		lookup: async () => {
			lookups++;
			if ((scenario === "initial-dns" && lookups === 1) || (scenario === "transport-dns" && lookups === 2)) controller.abort();
			return [{ address: "93.184.216.34", family: 4 }];
		},
	});
} else {
	const responses = {
		"declared-oversize": { type: "text/plain", length: 6 * 1024 * 1024 },
		"raw-unsupported-type": { type: "application/octet-stream" },
		"disabled-pdf": { type: "application/pdf" },
		"http-error": { type: "text/plain", status: 503 },
		"disabled-image": { type: "image/png" },
		"unsupported-readable": { type: "application/zip" },
		"config-error": { type: "application/pdf" },
		"streamed-oversize": { type: "text/plain", body: "x".repeat(5 * 1024 * 1024 + 1) },
		"abort-reading": { type: "text/plain" },
		"timeout-reading": { type: "text/plain" },
		"successful-body": { type: "text/plain", body: "finished", finish: true },
		"empty-body": { type: "text/plain", status: 204, finish: true },
	};
	const response = responses[scenario];
	let resolveClosed, abortTimer, observationTimer;
	const closed = new Promise(resolve => { resolveClosed = resolve; });
	const server = createServer((_req, res) => {
		requests++;
		res.on("close", () => resolveClosed(true));
		// Simulate a config edit after the request starts but before PDF handling.
		if (scenario === "config-error") writeFileSync(configPath, "{broken");
		res.writeHead(response.status ?? 200, {
			"content-type": response.type,
			...(response.length ? { "content-length": String(response.length) } : {}),
		});
		if (response.finish) res.end(response.body);
		else res.write(response.body ?? "unfinished body");
		if (scenario === "abort-reading") abortTimer = setTimeout(() => controller.abort(), 30);
	});
	try {
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		result = await extractContent(`http://lifecycle.fetch.test:${server.address().port}/${scenario}`, controller.signal, {
			mode, timeoutMs: scenario === "timeout-reading" ? 500 : 5000,
			lookup: async () => [{ address: "127.0.0.1", family: 4 }],
		});
		// Observe closure before the ordinary request timeout could mask a leak.
		bodyClosed = await Promise.race([closed, new Promise(resolve => {
			observationTimer = setTimeout(() => resolve(false), 1000);
		})]);
	} finally {
		clearTimeout(abortTimer);
		clearTimeout(observationTimer);
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
	}
}

console.log(JSON.stringify({ requests, cookieReads, lookups, cancelCalls, bodyClosed, result, settledBeforeDns, settledBeforeCookie, redirectCancels,
	aborted: controller.signal.aborted, abortListeners: getEventListeners(controller.signal, "abort").length }));
