import { createRequire, registerHooks } from "node:module";

// Each invocation runs in an isolated home. No browser data or network is used.
const [provider, scenario] = process.argv.slice(2);
const calls = [];
const cancelled = [];
const cookies = [];
const lookups = [];
const cookieUrl = new URL("../chrome-cookies.ts", import.meta.url).href;
globalThis.fixtureCookies = async ({ requestUrl }) => {
	cookies.push(requestUrl.pathname);
	if (scenario === "cookie-error" && requestUrl.pathname === "/next") throw new Error("cookie fixture failed");
	return { cookieHeader: `fixture=${requestUrl.pathname}` };
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

const require = createRequire(import.meta.url);
const undici = require("undici");
const Agent = undici.Agent;
const connectors = new WeakMap();
undici.Agent = class extends Agent {
	constructor(options) {
		super(options);
		connectors.set(this, options.connect.lookup);
	}
};
function respond(rawUrl, init, address) {
	const url = new URL(rawUrl);
	calls.push({ url: url.href, address, method: init.method ?? "GET", body: init.body ?? null,
		headers: Object.fromEntries(new Headers(init.headers)), redirect: init.redirect });
	if (scenario !== "direct" && (calls.length === 1 || scenario === "loop")) {
		const location = scenario === "private" ? "http://127.0.0.1/private"
			: scenario === "invalid" ? "http://["
				: scenario === "cross-origin" ? "https://other.fetch.test/next"
					: scenario === "loop" ? `/hop${calls.length}` : "/next";
		return new Response(new ReadableStream({ cancel() { cancelled.push(url.href); } }), {
			status: scenario.startsWith("status-") ? Number(scenario.slice(7)) : 307, headers: { location },
		});
	}
	const body = provider === "firecrawl" ? JSON.stringify({ success: true, data: { markdown: "fixture body" } }) : "fixture body";
	return new Response(body, { headers: { "content-type": provider === "firecrawl" ? "application/json" : "text/plain" } });
}
undici.fetch = async (url, init) => {
	const lookup = connectors.get(init.dispatcher);
	if (!lookup) throw new Error("Missing validated connection lookup");
	const addresses = await new Promise((resolve, reject) => {
		lookup(new URL(url).hostname, { all: true }, (error, result) => error ? reject(error) : resolve(result));
	});
	return respond(url, init, addresses[0].address);
};
// Model a different DNS answer from the one returned during SSRF validation.
globalThis.fetch = async (url, init) => respond(url, init, "127.0.0.1");
const lookup = async hostname => {
	lookups.push(hostname);
	return [{ address: hostname === "other.fetch.test" ? "93.184.216.35" : "93.184.216.34", family: 4 }];
};
let result;
let error = null;
try {
	if (provider === "auth") {
		const { extractContent } = await import("../extract.ts");
		result = await extractContent("https://auth.fetch.test/start", undefined, {
			mode: "raw", lookup, authFetchProfile: { name: "fixture", hosts: ["auth.fetch.test"], redirects: "same-origin", cache: "off" },
		});
		error = result.error;
	} else if (provider === "firecrawl") {
		const { extractWithFirecrawl } = await import("../firecrawl.ts");
		result = await extractWithFirecrawl("https://content.fetch.test/article", undefined, { lookup });
	} else {
		const { extractWithBrightDataUnlocker } = await import("../brightdata-unlocker.ts");
		result = await extractWithBrightDataUnlocker("https://content.fetch.test/article", undefined, { lookup });
	}
} catch (caught) {
	error = caught.message;
}
console.log(JSON.stringify({ calls, cancelled, cookies, lookups, result, error }));
