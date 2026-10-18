import assert from "node:assert/strict";
import { test } from "node:test";

test("Treg free-only search contract", async (t) => {
  const previousToken = process.env.TREG_TOKEN;
  const previousDb = process.env.AGENT_DB;
  const originalFetch = globalThis.fetch;
  process.env.AGENT_DB = ":memory:";
  process.env.TREG_TOKEN = "test-secret";
  const { webSearch, collectResearch, tregHealth } = await import("./research");
  try {
    await t.test("refuses a non-free catalog entry before making a call", async () => {
      let requests = 0;
      globalThis.fetch = async () => {
        requests++;
        return Response.json({ endpoint: { cost: { type: "per_call", usd: 0.01 } } });
      };
      assert.equal(await webSearch("test"), null);
      assert.equal(requests, 1);
      assert.match(tregHealth.lastError!, /not listed as free/);
    });
    await t.test("authenticates with a zero cost cap and records actual result metadata", async () => {
      globalThis.fetch = async (url, init) => {
        if (String(url).includes("/catalog/")) return Response.json({ endpoint: { cost: { type: "free", usd: 0 } } });
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("X-Treg-Token"), "test-secret");
        assert.equal(headers.get("X-Treg-Route-Max-Cost"), "0");
        assert.equal(headers.get("X-Treg-Route-Waterfall"), "0");
        assert.equal(init?.redirect, "error");
        return Response.json({ results: [{ title: "Source", url: "https://example.com", snippet: "Evidence" }] }, { headers: { "X-Treg-Cost-Micro": "0", "X-Treg-Call-Id": "call-test" } });
      };
      assert.deepEqual(await webSearch("test"), [{ title: "Source", url: "https://example.com/", snippet: "Evidence" }]);
      assert.equal(tregHealth.lastCallId, "call-test");
      assert.equal(tregHealth.lastCostMicro, 0);
      assert.equal(tregHealth.lastError, null);
    });
    await t.test("does not treat a malformed response as an empty successful search", async () => {
      globalThis.fetch = async () => Response.json({ error: "provider unavailable" });
      assert.equal(await webSearch("test"), null);
      assert.match(tregHealth.lastError!, /unexpected search response/);
    });
    await t.test("does not accept an upstream failure inside HTTP 200", async () => {
      globalThis.fetch = async () => Response.json({ results: [] }, { headers: { "X-Treg-Upstream-Failed": "status=error" } });
      assert.equal(await webSearch("test"), null);
      assert.match(tregHealth.lastError!, /upstream reported/);
    });
    await t.test("keeps empty contract search distinct from identity context and failed narrative search", async () => {
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        if (calls === 3) throw new Error("Provider timeout");
        return Response.json({ results: calls === 1 ? [] : [{ title: "Namesake", url: "https://example.com/namesake", snippet: "A different token with the same name" }] }, { headers: { "X-Treg-Cost-Micro": "0", "X-Treg-Call-Id": `call-${calls}` } });
      };
      const r = await collectResearch({ mint: "A".repeat(32), name: "Example", symbol: "EX", socials: { twitter: null, website: null, telegram: null } });
      assert.deepEqual(r.searches.map((q) => [q.kind, q.status]), [["contract", "empty"], ["identity", "ok"], ["narrative", "error"]]);
      assert.equal(r.sources.length, 1);
      assert.equal(r.sources[0].mentionsContract, false);
      assert.equal(r.sources[0].via, "search_snippet");
    });
    await t.test("disables further requests if the server reports any charge", async () => {
      let requests = 0;
      globalThis.fetch = async () => {
        requests++;
        return Response.json({ results: [] }, { headers: { "X-Treg-Cost-Micro": "1" } });
      };
      assert.equal(await webSearch("test"), null);
      assert.match(tregHealth.disabled!, /reported a cost/);
      assert.equal(await webSearch("test again"), null);
      assert.equal(requests, 1);
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.TREG_TOKEN;
    else process.env.TREG_TOKEN = previousToken;
    if (previousDb === undefined) delete process.env.AGENT_DB;
    else process.env.AGENT_DB = previousDb;
  }
});
