import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoinState } from "./state";

test("Pulse filters: unknown stays checking, a failed ceiling hides the coin, presets reset", async () => {
  process.env.AGENT_DB = ":memory:";
  const { evaluatePulse, setFilters, filtersFor, PRESETS } = await import("./pulse");
  const now = Date.now();
  const s = {
    coin: {
      mint: "P".repeat(32), name: "Test", symbol: "TST", creator: "c", stage: "curve", createdAt: now - 5 * 60_000,
      socials: { twitter: "https://x.com/t", website: null, telegram: null }, mcapUsd: 9_000, athMcapUsd: 12_000, curveProgress: 0.2,
    },
    quote: null, holders: null, features: null, market: null,
  } as unknown as CoinState;

  let e = evaluatePulse(s, now)!;
  assert.equal(e.column, "newPairs");
  assert.equal(e.status, "checking", "no holder or activity data yet");
  assert.ok(e.unknown.includes("top10Holders") && e.unknown.includes("volume"));

  s.market = { at: now, volumeUsd: { m5: 100, h1: 2_000, h24: 2_000 }, buys: { m5: 5, h1: 40, h24: 40 }, sells: { m5: 2, h1: 20, h24: 20 }, liquidityUsd: 5_000, mcapUsd: 9_000, dexPaid: false };
  s.holders = { at: now, totalHolders: 80, top: [], top10ExPoolPct: 45, insidersDetected: 0, insiderPct: 0, creatorPct: 2, mintAuthority: null, freezeAuthority: null, metadataMutable: false, lpLockedPct: null, rugged: false, risks: [] };
  e = evaluatePulse(s, now)!;
  assert.equal(e.status, "fail");
  assert.deepEqual(e.failed, ["top10Holders"], "top 10 at 45% breaks the 30% ceiling");

  setFilters("newPairs", { ...filtersFor("newPairs"), top10Holders: { min: null, max: 50 }, snipers: { min: null, max: null }, bundle: { min: null, max: null } });
  e = evaluatePulse(s, now)!;
  assert.equal(e.status, "pass");

  setFilters("newPairs", "preset");
  assert.deepEqual(filtersFor("newPairs"), PRESETS.newPairs);
});
