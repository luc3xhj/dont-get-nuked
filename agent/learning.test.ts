import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoinState } from "./state";
import type { Trade } from "./types";

test("trader learning: FIFO episodes, cohort chronology, evidence labels, follower policy", async (t) => {
  process.env.AGENT_DB = ":memory:";
  const { db, saveTrades, saveCoin } = await import("./db");
  const { walletEpisodes, cohortAt } = await import("./traders");
  const { blockBootstrap, evidenceLabel, seedRegistry, learningReport } = await import("./learning");
  const pf = await import("./portfolio");
  const { coins } = await import("./state");

  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  let n = 0;
  const tr = (wallet: string, mint: string, side: "buy" | "sell", sol: number, tokens: number, ts = now): Trade =>
    ({ id: String(++n).padStart(12, "0"), tx: `t${n}`, mint, ts, slot: n, wallet, side, sol, tokens, priceSol: sol / tokens, program: "pump", receivedAt: ts }) as Trade;

  await t.test("episodes: unknown-basis sales never create profit", () => {
    const w = "W".repeat(44);
    saveTrades([tr(w, "A".repeat(32), "buy", 1, 1000), tr(w, "A".repeat(32), "sell", 1.5, 1000), tr(w, "B".repeat(32), "sell", 2, 500)]);
    const eps = walletEpisodes(w);
    const a = eps.find((e) => e.mint === "A".repeat(32))!;
    assert.equal(a.status, "closed");
    assert.ok(Math.abs(a.realizedSol! - 0.5) < 1e-9);
    const b = eps.find((e) => e.mint === "B".repeat(32))!;
    assert.equal(b.realizedSol, null, "a sale with no observed buy has unknown basis");
    assert.equal(b.unknownBasisTokens, 500);
  });

  await t.test("cohorts: a wallet selected today is not in yesterday's cohort", () => {
    db.prepare("INSERT INTO wallet_cohorts (selected_at, selection_rule, rule_hash, members) VALUES (?, '{}', 'h', ?)").run(now - 86_400_000, JSON.stringify(["old"]));
    db.prepare("INSERT INTO wallet_cohorts (selected_at, selection_rule, rule_hash, members) VALUES (?, '{}', 'h', ?)").run(now, JSON.stringify(["old", "new"]));
    assert.deepEqual(cohortAt(now - 3600_000)!.members, ["old"]);
    assert.deepEqual(cohortAt(now)!.members, ["old", "new"]);
    assert.equal(cohortAt(now - 2 * 86_400_000), null);
  });

  await t.test("evidence labels: small or overlapping samples never read as supported", () => {
    const day = 86_400_000;
    const mk = (pnl: number, i: number) => ({ account: "x", setup: "s", closedAt: now - (i % 5) * day, pnlSol: pnl, r: 0 });
    const good = Array.from({ length: 60 }, (_, i) => mk(0.02 + (i % 3) * 0.001, i));
    const ref = Array.from({ length: 60 }, (_, i) => mk(-0.01 + (i % 3) * 0.001, i));
    const cmp = blockBootstrap(good, ref, 500, "t");
    assert.ok(cmp && cmp.ci90[0] > 0);
    assert.equal(evidenceLabel(60, cmp), "supported within observed conditions");
    assert.equal(evidenceLabel(8, cmp), "instrumented");
    const noisy = Array.from({ length: 60 }, (_, i) => mk(i % 2 ? 0.05 : -0.05, i));
    assert.equal(evidenceLabel(60, blockBootstrap(noisy, noisy, 500, "u")), "provisional");
    seedRegistry(now);
    const rep = learningReport();
    assert.ok(rep.hypotheses.some((h) => (h as Record<string, unknown>).id === "H-research-value"));
    assert.ok(rep.experiments.every((e) => (e as Record<string, unknown>).status === "running"));
  });

  await t.test("follower: own quote, run-up rejected, leader sale closes only the follower lot", () => {
    pf.setDrawSource(() => ({ latency: 0.5, fail: 0.5 }));
    pf.restorePortfolio();
    const mint = "F".repeat(32);
    const s = {
      coin: { mint, name: "F", symbol: "F", creator: "c", curve: "x", pool: "p", stage: "migrated", createdAt: now - 3600_000, socials: { twitter: null, website: null, telegram: null }, replies: 0, mcapUsd: 1, athMcapUsd: null, curveProgress: 1, lastTradeAt: now, firstSeen: now, updatedAt: now },
      quote: { at: now, priceSol: 1e-6, priceUsd: 1.5e-4, liquidityUsd: 30_000, mcapUsd: 100_000, reserveTokens: 100_000_000, reserveSol: 100 },
      hot: true, trades: [], ids: new Set(), pulse: { status: "pass" }, screens: [], setups: [], features: null, analysis: null, holders: null, funding: null,
    } as unknown as CoinState;
    coins.set(mint, s);
    saveCoin(s.coin);
    const leader = "L".repeat(44);
    const tracked = (w: string) => w === leader;
    // The price already ran 20% past the leader's fill: rejected.
    pf.followerOnTrades(s, [tr(leader, mint, "buy", 0.5, 0.5 / 0.8e-6)], tracked, now);
    assert.equal(pf.portfolioReport().pending.filter((o) => o.account === "follower").length, 0);
    // A fresh buy at about the current price is followed (after the per-coin cool-down).
    now += 11 * 60_000;
    s.quote = { ...s.quote!, at: now };
    pf.followerOnTrades(s, [tr(leader, mint, "buy", 0.5, 0.5 / 1e-6, now)], tracked, now);
    assert.equal(pf.portfolioReport().pending.filter((o) => o.account === "follower").length, 1);
    now += 4_000;
    s.quote = { ...s.quote!, at: now };
    pf.portfolioTick();
    const lot = pf.portfolioReport().open.find((p) => p.account === "follower")!;
    assert.ok(lot && lot.r0Sol! > 0);
    // Another wallet selling changes nothing; the leader selling requests the follower's exit.
    pf.followerOnTrades(s, [tr("X".repeat(44), mint, "sell", 0.5, 1000, now)], tracked, now);
    assert.equal(pf.portfolioReport().open.find((p) => p.account === "follower")!.exiting, false);
    pf.followerOnTrades(s, [tr(leader, mint, "sell", 0.5, 1000, now)], tracked, now);
    assert.equal(pf.portfolioReport().open.find((p) => p.account === "follower")!.exiting, true);
    assert.ok(pf.reconciliationReport().ok, pf.reconciliationReport().issues.join("; "));
  });
});
