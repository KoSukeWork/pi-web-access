import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { fetchRemoteUrl } from "../ssrf-protection.ts";

test("real pinned HTTP supports one/multiple addresses, large bodies, redirects and cancellation", { timeout: 15000 }, async () => {
  const large = "x".repeat(2 * 1024 * 1024);
  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/large" });
      res.write(large); // Deliberately leave the redirect body unfinished.
    } else if (req.url === "/stream") {
      res.writeHead(200); res.write("start");
    } else { res.end(req.url === "/large" ? large : "ok"); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const url = `http://pinned.invalid:${port}`;
  try {
    for (const count of [1, 2]) {
      const options = { lookup: async () => Array.from({ length: count }, () => ({ address: "127.0.0.1", family: 4 })), allowRanges: ["127.0.0.1/32"] };
      assert.equal(await (await fetchRemoteUrl(url, { signal: AbortSignal.timeout(5000) }, options)).text(), "ok");
      assert.equal(await (await fetchRemoteUrl(`${url}/large`, { signal: AbortSignal.timeout(5000) }, options)).text(), large);
      assert.equal(await (await fetchRemoteUrl(`${url}/redirect`, { signal: AbortSignal.timeout(5000) }, options)).text(), large);
      const response = await fetchRemoteUrl(`${url}/stream`, { signal: AbortSignal.timeout(5000) }, options);
      await response.body?.cancel();
      const controller = new AbortController();
      const aborted = await fetchRemoteUrl(`${url}/stream`, { signal: controller.signal }, options);
      const body = aborted.text();
      controller.abort();
      await assert.rejects(body, { name: "AbortError" });
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
