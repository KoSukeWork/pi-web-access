import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";

import { fetchRemoteUrl, resolveValidatedRemoteTarget, validateRemoteUrl } from "../ssrf-protection.ts";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

async function observeSettlement(promise) {
	let timer;
	try {
		return await Promise.race([
			promise.then(value => ({ value }), error => ({ error })),
			new Promise(resolve => { timer = setTimeout(() => resolve(null), 250); }),
		]);
	} finally {
		clearTimeout(timer);
	}
}

test("pre-aborted validation never starts DNS and preserves the caller's reason", async () => {
	const controller = new AbortController();
	const reason = new Error("caller cancelled");
	controller.abort(reason);
	let lookups = 0;
	await assert.rejects(validateRemoteUrl("https://example.test/", {
		signal: controller.signal, lookup: async () => { lookups++; return publicLookup(); },
	}), error => error === reason);
	assert.equal(lookups, 0);
});

for (const lateOutcome of ["resolve", "reject"]) {
	test(`DNS cancellation settles before a late resolver ${lateOutcome} and removes its listener`, async () => {
		const entered = Promise.withResolvers(), gate = Promise.withResolvers();
		const controller = new AbortController(), reason = new Error("caller cancelled");
		const pending = validateRemoteUrl("https://example.test/", {
			signal: controller.signal, lookup: () => { entered.resolve(); return gate.promise; },
		});
		await entered.promise;
		controller.abort(reason);
		try {
			assert.deepEqual(await observeSettlement(pending), { error: reason });
			assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		} finally {
			if (lateOutcome === "reject") gate.reject(new Error("late DNS failure"));
			else gate.resolve(await publicLookup());
			await pending.catch(() => {});
			await nextTurn(); // Late rejection must also be handled after cancellation.
		}
	});
}

for (const outcome of ["resolve", "reject", "throw"]) {
	test(`a DNS ${outcome} removes the abort listener without masking resolver errors`, async () => {
		const controller = new AbortController();
		const lookup = () => {
			if (outcome === "throw") throw new Error("resolver failed");
			return outcome === "reject" ? Promise.reject(new Error("resolver failed")) : publicLookup();
		};
		const pending = validateRemoteUrl("https://example.test/", { signal: controller.signal, lookup });
		if (outcome === "resolve") assert.equal((await pending).hostname, "example.test");
		else await assert.rejects(pending, /Failed to resolve example.test: resolver failed/);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	});
}

for (const phase of ["initial", "redirect"]) {
	for (const trigger of ["cancel", "timeout"]) {
		test(`${trigger} interrupts ${phase} DNS without sending the next request`, async () => {
			const entered = Promise.withResolvers(), gate = Promise.withResolvers();
			const controller = new AbortController();
			let lookups = 0, requests = 0, cancelledBodies = 0, timer;
			const pending = fetchRemoteUrl("https://example.test/", { signal: controller.signal }, {
				lookup: () => {
					if (++lookups === (phase === "initial" ? 1 : 2)) { entered.resolve(); return gate.promise; }
					return publicLookup();
				},
				fetch: async () => {
					requests++;
					return new Response(new ReadableStream({ cancel() { cancelledBodies++; } }), {
						status: 302, headers: { location: "https://next.example.test/" },
					});
				},
			});
			await entered.promise;
			if (trigger === "cancel") controller.abort();
			else timer = setTimeout(() => controller.abort(), 10);
			try {
				const observed = await observeSettlement(pending);
				assert.equal(observed?.error?.name, "AbortError");
				assert.equal(requests, phase === "initial" ? 0 : 1);
				assert.equal(cancelledBodies, phase === "initial" ? 0 : 1);
				assert.equal(getEventListeners(controller.signal, "abort").length, 0);
			} finally {
				clearTimeout(timer);
				gate.resolve(await publicLookup());
				await pending.catch(() => {});
			}
		});
	}
}

for (const signalSource of ["init", "options"]) {
	for (const lateOutcome of ["resolve", "reject"]) {
		test(`request hook cancellation via ${signalSource} handles a late ${lateOutcome} and releases its listener`, async () => {
			const entered = Promise.withResolvers(), gate = Promise.withResolvers();
			const controller = new AbortController(), reason = new Error("cancel pending cookie lookup");
			let requests = 0;
			const pending = fetchRemoteUrl("https://example.test/", signalSource === "init" ? { signal: controller.signal } : {}, {
				...(signalSource === "options" ? { signal: controller.signal } : {}),
				lookup: publicLookup,
				onRequest: ({ init }) => { entered.resolve(); return gate.promise.then(() => init); },
				fetch: async () => { requests++; return new Response("ok"); },
			});
			await entered.promise;
			controller.abort(reason);
			try {
				assert.deepEqual(await observeSettlement(pending), { error: reason });
				assert.equal(getEventListeners(controller.signal, "abort").length, 0);
			} finally {
				if (lateOutcome === "reject") gate.reject(new Error("late cookie failure"));
				else gate.resolve();
				await pending.catch(() => {});
				await nextTurn();
			}
			assert.equal(requests, 0);
		});
	}
}

for (const outcome of ["resolve", "reject", "throw"]) {
	test(`a request hook ${outcome} releases the abort listener and preserves its result`, async () => {
		const controller = new AbortController(), reason = new Error("cookie lookup failed");
		let requests = 0;
		const pending = fetchRemoteUrl("https://example.test/", { signal: controller.signal }, {
			lookup: publicLookup,
			onRequest: ({ init }) => {
				if (outcome === "throw") throw reason;
				return outcome === "reject" ? Promise.reject(reason) : { ...init, headers: { cookie: "fixture=value" } };
			},
			fetch: async (_url, init) => { requests++; assert.equal(new Headers(init.headers).get("cookie"), "fixture=value"); return new Response("ok"); },
		});
		if (outcome === "resolve") assert.equal(await (await pending).text(), "ok");
		else await assert.rejects(pending, error => error === reason);
		assert.equal(requests, outcome === "resolve" ? 1 : 0);
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	});
}

test("a hook cannot discard cancellation by returning a new request init", async () => {
	const controller = new AbortController();
	let requests = 0;
	await assert.rejects(fetchRemoteUrl("https://example.test/", { signal: controller.signal }, {
		lookup: publicLookup,
		onRequest: () => { controller.abort(); return {}; },
		fetch: async () => { requests++; return new Response("ok"); },
	}), { name: "AbortError" });
	assert.equal(requests, 0);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

async function rejectsInternal(url) {
	await assert.rejects(
		validateRemoteUrl(url, { lookup: publicLookup }),
		/internal|Blocked/,
		`${url} should be blocked`,
	);
}

test("validateRemoteUrl blocks localhost, loopback, link-local, private, and metadata targets", async () => {
	await rejectsInternal("http://localhost/");
	await rejectsInternal("http://127.0.0.1/");
	await rejectsInternal("http://10.0.0.1/");
	await rejectsInternal("http://172.16.0.1/");
	await rejectsInternal("http://192.168.1.1/");
	await rejectsInternal("http://169.254.169.254/latest/meta-data/");
	await rejectsInternal("http://0.0.0.0/");
	await rejectsInternal("http://[::1]/");
	await rejectsInternal("http://[fe80::1]/");
	await rejectsInternal("http://[fd00::1]/");
	await rejectsInternal("http://[::ffff:127.0.0.1]/");
});

test("validateRemoteUrl blocks encoded and alternate loopback IPv4 forms", async () => {
	await rejectsInternal("http://2130706433/");
	await rejectsInternal("http://0177.0.0.1/");
	await rejectsInternal("http://0x7f.0.0.1/");
	await rejectsInternal("http://127.1/");
});

test("validateRemoteUrl blocks hostnames that resolve to private addresses", async () => {
	await assert.rejects(
		validateRemoteUrl("https://example.test/", {
			lookup: async () => [{ address: "192.168.0.2", family: 4 }],
		}),
		/Blocked internal address for example\.test: 192\.168\.0\.2/,
	);

	await assert.rejects(
		validateRemoteUrl("https://example.test/", {
			lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "fd00::1", family: 6 }],
		}),
		/Blocked internal address for example\.test: fd00::1/,
	);
});

test("resolveValidatedRemoteTarget pins public hostname lookups", async () => {
	const resolved = await resolveValidatedRemoteTarget("https://example.test/path", { lookup: publicLookup });
	assert.equal(resolved.url.hostname, "example.test");
	assert.deepEqual(resolved.pinAddresses, [{ address: "93.184.216.34", family: 4 }]);
});

test("resolveValidatedRemoteTarget does not pin literal IPs or trusted env proxies", async () => {
	assert.equal((await resolveValidatedRemoteTarget("http://93.184.216.34/")).pinAddresses, null);
	const previous = process.env.HTTPS_PROXY;
	process.env.HTTPS_PROXY = "http://127.0.0.1:8888";
	try {
		const resolved = await resolveValidatedRemoteTarget("https://example.test/", {
			lookup: publicLookup,
			trustEnvProxy: true,
		});
		assert.equal(resolved.pinAddresses, null);
	} finally {
		if (previous === undefined) delete process.env.HTTPS_PROXY;
		else process.env.HTTPS_PROXY = previous;
	}
});

test("validateRemoteUrl permits public HTTP and HTTPS targets", async () => {
	assert.equal((await validateRemoteUrl("https://example.com/path", { lookup: publicLookup })).hostname, "example.com");
	assert.equal((await validateRemoteUrl("http://93.184.216.34/")).hostname, "93.184.216.34");
	assert.equal((await validateRemoteUrl("https://[2606:2800:220:1:248:1893:25c8:1946]/")).hostname, "[2606:2800:220:1:248:1893:25c8:1946]");
});

test("domain policy allows exact and subdomain matches, and is off by default", async () => {
	assert.equal((await validateRemoteUrl("https://example.com/", { lookup: publicLookup })).hostname, "example.com");
	assert.equal((await validateRemoteUrl("https://www.example.com/", {
		lookup: publicLookup,
		domainPolicy: { allow: ["example.com"], deny: [] },
	})).hostname, "www.example.com");
	await assert.rejects(
		validateRemoteUrl("https://other.test/", {
			lookup: publicLookup,
			domainPolicy: { allow: ["example.com"], deny: [] },
		}),
		/Hostname not allowed by fetch_content domain policy/,
	);
});

test("domain policy deny wins over allow", async () => {
	await assert.rejects(
		validateRemoteUrl("https://private.example.com/", {
			lookup: publicLookup,
			domainPolicy: { allow: ["example.com"], deny: ["private.example.com"] },
		}),
		/Blocked hostname by fetch_content domain policy/,
	);
});

test("domain policy validates redirect targets before following", async () => {
	const requested = [];
	const fetchImpl = async (url) => {
		requested.push(url.toString());
		return new Response("", { status: 302, headers: { location: "https://denied.example/next" } });
	};

	await assert.rejects(
		fetchRemoteUrl("https://allowed.example/", {}, {
			lookup: publicLookup,
			fetch: fetchImpl,
			domainPolicy: { allow: ["allowed.example"], deny: ["denied.example"] },
		}),
		/Blocked hostname by fetch_content domain policy/,
	);
	assert.deepEqual(requested, ["https://allowed.example/"]);
});

test("domain policy never relaxes SSRF protection", async () => {
	await assert.rejects(
		validateRemoteUrl("http://127.0.0.1/", {
			domainPolicy: { allow: ["127.0.0.1"], deny: [] },
		}),
		/Blocked internal address/,
	);
	await assert.rejects(
		validateRemoteUrl("https://internal.example/", {
			lookup: async () => [{ address: "10.0.0.5", family: 4 }],
			domainPolicy: { allow: ["example"], deny: [] },
		}),
		/Blocked internal address/,
	);
});

test("fetchRemoteUrl validates redirect targets before following", async () => {
	const requested = [];
	const fetchImpl = async (url) => {
		requested.push(url.toString());
		return new Response("", {
			status: 302,
			headers: { location: "http://127.0.0.1/admin" },
		});
	};

	await assert.rejects(
		fetchRemoteUrl("https://example.com/", {}, { lookup: publicLookup, fetch: fetchImpl }),
		/Blocked internal address/,
	);
	assert.deepEqual(requested, ["https://example.com/"]);
});

test("fetchRemoteUrl follows validated public redirects manually", async () => {
	const requested = [];
	const fetchImpl = async (url) => {
		requested.push(url.toString());
		if (requested.length === 1) {
			return new Response("", {
				status: 301,
				headers: { location: "/next" },
			});
		}
		return new Response("ok", { status: 200 });
	};

	const response = await fetchRemoteUrl("https://example.com/start", {}, { lookup: publicLookup, fetch: fetchImpl });
	assert.equal(response.status, 200);
	assert.equal(await response.text(), "ok");
	assert.deepEqual(requested, ["https://example.com/start", "https://example.com/next"]);
});

test("fake-IP block errors point to the allowRanges opt-in", async () => {
	const fakeIpLookup = async () => [{ address: "198.18.0.56", family: 4 }];

	await assert.rejects(
		validateRemoteUrl("https://example.test/", { lookup: fakeIpLookup }),
		/Blocked internal address for example\.test: 198\.18\.0\.56\..*TUN\/fake-IP proxies.*ssrf\.allowRanges.*198\.18\.0\.0\/15/,
	);
});

test("allowRanges exempts a synthetic fake-IP range (e.g. 198.18.0.0/15)", async () => {
	const fakeIpLookup = async () => [{ address: "198.18.0.56", family: 4 }];

	// Without the exemption this is blocked (the fake-IP proxy case).
	await assert.rejects(
		validateRemoteUrl("https://example.test/", { lookup: fakeIpLookup }),
		/Blocked internal address for example\.test: 198\.18\.0\.56/,
	);

	// With allowRanges it passes.
	const url = await validateRemoteUrl("https://example.test/", {
		lookup: fakeIpLookup,
		allowRanges: ["198.18.0.0/15"],
	});
	assert.equal(url.hostname, "example.test");

	// A bare literal IP in the range is also exempted.
	assert.equal((await validateRemoteUrl("http://198.18.0.99/", { allowRanges: ["198.18.0.0/15"] })).hostname, "198.18.0.99");
});

test("allowRanges works for IPv6 ranges", async () => {
	const fakeIp6Lookup = async () => [{ address: "fd00::1", family: 6 }];

	await assert.rejects(
		validateRemoteUrl("https://example.test/", { lookup: fakeIp6Lookup }),
		/Blocked internal address for example\.test: fd00::1/,
	);

	const url = await validateRemoteUrl("https://example.test/", {
		lookup: fakeIp6Lookup,
		allowRanges: ["fd00::/8"],
	});
	assert.equal(url.hostname, "example.test");
});

test("allowRanges does not relax protection outside the listed range", async () => {
	// 10.0.0.1 is private; an unrelated exemption must NOT cover it.
	await assert.rejects(
		validateRemoteUrl("https://example.test/", {
			lookup: async () => [{ address: "10.0.0.1", family: 4 }],
			allowRanges: ["198.18.0.0/15"],
		}),
		/Blocked internal address for example\.test: 10\.0\.0\.1/,
	);

	// Exact /32 boundary: allowed in-range, blocked just outside.
	assert.equal((await validateRemoteUrl("http://198.18.0.0/", { allowRanges: ["198.18.0.0/31"] })).hostname, "198.18.0.0");
	assert.equal((await validateRemoteUrl("http://198.18.0.1/", { allowRanges: ["198.18.0.0/31"] })).hostname, "198.18.0.1");
	await assert.rejects(
		validateRemoteUrl("http://198.18.0.2/", { allowRanges: ["198.18.0.0/31"] }),
		/Blocked internal address/,
	);
});

test("allowRanges accepts a bare host (no prefix) and treats it as /32", async () => {
	assert.equal((await validateRemoteUrl("http://198.18.1.2/", { allowRanges: ["198.18.1.2"] })).hostname, "198.18.1.2");
});

test("allowRanges rejects an empty or non-numeric CIDR prefix instead of treating it as /0", async () => {
	// Regression: a trailing slash with no prefix (e.g. "198.18.0.0/") must NOT
	// become /0, which would exempt every address from the SSRF guard.
	for (const bad of ["198.18.0.0/", "198.18.0.0/ ", "fd00::/", "10.0.0.0/abc", "10.0.0.0/ 8"]) {
		await assert.rejects(
			validateRemoteUrl("http://198.18.0.5/", { allowRanges: [bad] }),
			/Invalid CIDR notation in ssrf\.allowRanges/,
			`${bad} should be rejected`,
		);
	}

	// The dangerous outcome is prevented: a metadata/private IP is not exempted
	// by a malformed "/" entry; the misconfiguration surfaces as an error.
	await assert.rejects(
		validateRemoteUrl("http://169.254.169.254/", { allowRanges: ["198.18.0.0/"] }),
		/Invalid CIDR notation in ssrf\.allowRanges/,
	);
});

test("allowRanges rejects all-address /0 CIDRs", async () => {
	await assert.rejects(
		validateRemoteUrl("http://169.254.169.254/", { allowRanges: ["0.0.0.0/0"] }),
		/Invalid CIDR notation in ssrf\.allowRanges/,
	);
	await assert.rejects(
		validateRemoteUrl("http://[fd00::1]/", { allowRanges: ["::/0"] }),
		/Invalid CIDR notation in ssrf\.allowRanges/,
	);
});

test("invalid allowRanges entries throw a descriptive error", async () => {
	for (const bad of ["not-an-ip", "198.18.0.0/33", "198.18.0.0/-1", "999.0.0.0/8", "fd00::/129"]) {
		await assert.rejects(
			validateRemoteUrl("http://198.18.0.5/", { allowRanges: [bad] }),
			new RegExp(`Invalid CIDR notation in ssrf\.allowRanges: "${bad.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\$&")}"`),
		);
	}
	await assert.rejects(
		validateRemoteUrl("http://198.18.0.5/", { allowRanges: "198.18.0.0/15" }),
		/ssrf\.allowRanges must be an array/,
	);
});

test("allowRanges flows through fetchRemoteUrl and its redirect targets", async () => {
	const requested = [];
	const fetchImpl = async (url) => {
		requested.push(url.toString());
		if (requested.length === 1) {
			return new Response("", { status: 302, headers: { location: "http://198.18.0.99/admin" } });
		}
		return new Response("ok", { status: 200 });
	};

	const response = await fetchRemoteUrl(
		"https://example.com/",
		{},
		{ lookup: publicLookup, fetch: fetchImpl, allowRanges: ["198.18.0.0/15"] },
	);
	assert.equal(response.status, 200);
	assert.deepEqual(requested, ["https://example.com/", "http://198.18.0.99/admin"]);
});

test("trustEnvProxy skips hostname DNS only for a configured proxy", async () => {
	const previous = {
		HTTP_PROXY: process.env.HTTP_PROXY,
		http_proxy: process.env.http_proxy,
		HTTPS_PROXY: process.env.HTTPS_PROXY,
		https_proxy: process.env.https_proxy,
		ALL_PROXY: process.env.ALL_PROXY,
		all_proxy: process.env.all_proxy,
		NO_PROXY: process.env.NO_PROXY,
		no_proxy: process.env.no_proxy,
	};
	try {
		for (const key of Object.keys(previous)) delete process.env[key];
		process.env.HTTPS_PROXY = "http://proxy.example.test:8080";
		let lookups = 0;
		const lookup = async () => {
			lookups++;
			throw new Error("DNS should not run for proxied host");
		};

		await validateRemoteUrl("https://public.example.test/", { trustEnvProxy: true, lookup });
		assert.equal(lookups, 0);

		await assert.rejects(
			validateRemoteUrl("https://127.0.0.1/", { trustEnvProxy: true, lookup }),
			/Blocked internal address/,
		);
		await assert.rejects(
			validateRemoteUrl("https://localhost/", { trustEnvProxy: true, lookup }),
			/Blocked internal hostname/,
		);
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("trustEnvProxy ignores invalid proxy environment values", async () => {
	const previous = {
		HTTP_PROXY: process.env.HTTP_PROXY,
		http_proxy: process.env.http_proxy,
		HTTPS_PROXY: process.env.HTTPS_PROXY,
		https_proxy: process.env.https_proxy,
		ALL_PROXY: process.env.ALL_PROXY,
		all_proxy: process.env.all_proxy,
		NO_PROXY: process.env.NO_PROXY,
		no_proxy: process.env.no_proxy,
	};
	try {
		for (const key of Object.keys(previous)) delete process.env[key];
		for (const value of ["garbage", "file:///tmp/proxy", "   "]) {
			process.env.HTTPS_PROXY = value;
			let lookups = 0;
			const url = await validateRemoteUrl("https://public.example.test/", {
				trustEnvProxy: true,
				lookup: async () => {
					lookups++;
					return [{ address: "93.184.216.34", family: 4 }];
				},
			});
			assert.equal(url.hostname, "public.example.test");
			assert.equal(lookups, 1);
		}
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("trustEnvProxy still performs DNS for NO_PROXY hosts", async () => {
	const previous = {
		HTTPS_PROXY: process.env.HTTPS_PROXY,
		NO_PROXY: process.env.NO_PROXY,
	};
	try {
		process.env.HTTPS_PROXY = "http://proxy.example.test:8080";
		process.env.NO_PROXY = "public.example.test:443, .internal.example.test";
		let lookups = 0;
		const lookup = async () => {
			lookups++;
			return [{ address: "93.184.216.34", family: 4 }];
		};

		await validateRemoteUrl("https://public.example.test/", { trustEnvProxy: true, lookup });
		await validateRemoteUrl("https://api.internal.example.test/", { trustEnvProxy: true, lookup });
		assert.equal(lookups, 2);

		await validateRemoteUrl("https://public.example.test:8443/", { trustEnvProxy: true, lookup });
		assert.equal(lookups, 2);

		await validateRemoteUrl("https://other.example.test/", { trustEnvProxy: true, lookup });
		assert.equal(lookups, 2);
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});
