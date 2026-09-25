import { createRequire } from "node:module";

// Child tests replace global fetch with scenario-specific responses. Mirror that
// explicit mock at the pinned transport boundary as well. Production still uses
// matching undici fetch/Agent versions; ssrf-http.test.ts tests the real sockets.
const require = createRequire(import.meta.url);
const undici = require("undici");
const originalFetch = globalThis.fetch;
undici.fetch = (url, init) => {
	if (globalThis.fetch === originalFetch) throw new Error("Pinned HTTP test requires an explicit fetch mock");
	return globalThis.fetch(url, init);
};
