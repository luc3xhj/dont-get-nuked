import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoinState } from "./state";

test("funding: one failed lookup keeps the others, is categorized, and lowers coverage", async () => {
  process.env.AGENT_DB = ":memory:";
  const { fundingReport } = await import("./wallets");
  const { essentialsFor } = await import("./requirements");
  const now = Date.now();
  const top = ["A", "B", "C", "D"].map((x, i) => ({ owner: x.repeat(44), pct: [10, 5, 3, 2][i], insider: false }));
  const s = { coin: { mint: "M".repeat(32), socials: {}, createdAt: now }, holders: { at: now, top }, features: null, analysis: null, social: null } as unknown as CoinState;
  const lookup = async (address: string) => {
    if (address.startsWith("A")) throw new Error("RPC getTransaction: Failed to query long-term storage; please try again");
    return { address, at: now, txCount: 50, full: true, firstSeen: now - 30 * 86_400_000, funder: "F".repeat(44), funderBasis: "transfer" as const };
  };
  const r = await fundingReport(s, lookup);
  assert.equal(r.requested, 4);
  assert.equal(r.checked, 3, "the other three lookups survive");
  assert.equal(r.failed?.[0].category, "history_unavailable");
  assert.ok(Math.abs((r.coverage ?? 0) - 0.5) < 1e-9, "10% of 20% failed → 50% coverage");
  assert.equal(r.clusters[0].wallets.length, 3, "an adverse finding among checked wallets still stands");

  s.funding = r;
  const e = essentialsFor(s, "migrated_base", now).find((x) => x.id === "funding")!;
  assert.equal(e.ok, false, "partial coverage never passes");
  assert.match(e.detail, /coverage incomplete: 50%.*1 lookup failed; retry scheduled/);
});
