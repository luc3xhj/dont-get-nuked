import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoinState } from "./state";
import type { Trade } from "./types";

test("watchlist validation, per-coin positions and discovery from the tape", async () => {
  process.env.AGENT_DB = ":memory:";
  const { db, saveTrades } = await import("./db");
  const { watchWallet, unwatchWallet, tradersOnCoin, discoverTraders, tradersReport } = await import("./traders");

  assert.ok("error" in watchWallet({ address: "not-a-wallet" }));
  assert.ok("error" in watchWallet({ address: "W".repeat(44), xHandle: "has spaces" }));
  const w = watchWallet({ address: "W".repeat(44), name: "Alice", xHandle: "https://x.com/alice_sol" });
  assert.ok(!("error" in w) && w.xHandle === "alice_sol");

  const now = Date.now();
  const mint = "M".repeat(32);
  let n = 0;
  const trade = (wallet: string, side: "buy" | "sell", sol: number, tokens: number, ts: number): Trade => ({
    id: String(++n).padStart(12, "0"), tx: `tx${n}`, mint, ts, slot: n, wallet, side, sol, tokens, priceSol: sol / tokens, program: "pump",
  } as Trade);
  const trades = [
    trade("W".repeat(44), "buy", 1, 1_000_000, now - 60_000),
    trade("W".repeat(44), "sell", 1.2, 400_000, now - 30_000),
  ];
  const s = {
    coin: { mint, creator: "c", createdAt: now - 3600_000 },
    quote: { at: now, priceSol: 2e-6, priceUsd: 3e-4 },
    trades, fromLaunch: true, tapeGaps: 0,
  } as unknown as CoinState;
  const [t] = tradersOnCoin(s);
  assert.equal(t.name, "Alice");
  assert.equal(t.source, "watching");
  assert.ok(Math.abs(t.holdingPct - 60) < 1e-9);
  assert.ok(Math.abs(t.multiple! - 2) < 1e-9);
  // 1.2 realized + 600k tokens × 2e-6 − 1 cost
  assert.ok(Math.abs(t.pnlSol! - 1.4) < 1e-9);

  // A wallet that closes 5 coins, 4 of them in profit, ranks; a wallet that sold tokens we never saw it buy doesn't count those.
  const good = "G".repeat(44);
  const rows: Trade[] = [];
  for (let i = 0; i < 5; i++) {
    const m = `${i}`.repeat(32);
    rows.push({ ...trade(good, "buy", 1, 1000, now - 600_000), mint: m }, { ...trade(good, "sell", i < 4 ? 1.5 : 0.5, 1000, now - 300_000), mint: m });
    db.prepare("INSERT OR REPLACE INTO coins (mint, data, updated_at) VALUES (?, ?, ?)").run(m, JSON.stringify({ mint: m, createdAt: now - 3600_000 }), now);
  }
  saveTrades(rows);
  assert.equal(discoverTraders(now), 1);
  const report = tradersReport();
  assert.equal(report.discovered[0].address, good);
  assert.equal(report.discovered[0].closed, 5);
  assert.equal(report.discovered[0].wins, 4);
  assert.ok(report.discovered[0].winRateLower < 0.8, "small samples stay conservative");
  assert.equal(report.watching[0].name, "Alice");

  assert.equal(unwatchWallet("W".repeat(44)), true);
  assert.equal(tradersReport().watching.length, 0);
});
