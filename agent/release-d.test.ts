// Integrated acceptance scenarios (V2 §22): information first, protective exits while research is busy,
// overdue exits after downtime, one exposure per mint across sleeves, and capability degradation.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoinState } from "./state";
import type { SetupEval } from "./setups";

test("integrated scenarios", async (t) => {
  process.env.AGENT_DB = ":memory:";
  const { saveCoin } = await import("./db");
  const { coins } = await import("./state");
  const pf = await import("./portfolio");
  const discovery = await import("./discovery");
  const streams = await import("./streams");
  const { analystHealth } = await import("./analyst");
  const { capabilityReport, registerStreamStats } = await import("./capabilities");
  const { db } = await import("./db");

  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  pf.setDrawSource(() => ({ latency: 0.5, fail: 0.5 }));
  pf.restorePortfolio();

  let n = 0;
  function coin(mint = `${String(++n).padStart(2, "0")}${"Q".repeat(30)}`): CoinState {
    const s = {
      coin: { mint, name: `Q${n}`, symbol: `Q${n}`, creator: `cr${n}`, curve: "curve", pool: `pool${n}`, stage: "migrated", createdAt: now - 3600_000, migratedAt: now - 1800_000, socials: { twitter: null, website: null, telegram: null }, replies: 0, mcapUsd: 100_000, athMcapUsd: 150_000, curveProgress: 1, lastTradeAt: now, firstSeen: now - 3600_000, updatedAt: now },
      quote: { at: now, priceSol: 1e-6, priceUsd: 1.5e-4, liquidityUsd: 30_000, mcapUsd: 100_000, reserveTokens: 100_000_000, reserveSol: 100 },
      hot: true, hotSince: now, score: 1, trades: [], ids: new Set(), fromLaunch: false, backfilling: false, backfilled: true, nextPollAt: 0, tapeGaps: 0,
      holders: null, social: null, dev: null, funding: null, features: null, screens: [], setups: [], analysis: null,
    } as unknown as CoinState;
    coins.set(mint, s);
    saveCoin(s.coin);
    return s;
  }
  const fire: SetupEval = { setup: "migrated_base", status: "fire", structure: [], trigger: [], quality: 1, plan: { entrySol: 1e-6, stopSol: 0.85e-6, tp1Sol: 1.6e-6, tp2Sol: 2e-6, maxHoldMin: 30 } };
  const tick = (ms = 4_000) => {
    now += ms;
    for (const s of coins.values()) if (s.quote) s.quote = { ...s.quote, at: now };
    pf.portfolioTick();
  };
  const shadowLot = (mint: string) => pf.portfolioReport().open.find((p) => p.account === "shadow" && p.mint === mint);

  await t.test("information first: an unresolved reference becomes a validated candidate when the token appears", () => {
    const mint = "N".repeat(40) + "pump";
    discovery.ingestSearchResult({ id: "topic-x", topic: "X" }, { title: "Launch", url: "https://e.com/a", snippet: `CA ${mint}` }, { callId: null, receivedAt: now });
    const before = db.prepare("SELECT identity_state, state FROM candidates WHERE mint = ?").get(mint) as Record<string, string>;
    assert.equal(before.identity_state, "unresolved");
    now += 60_000;
    streams.handleMessage(JSON.stringify({ txType: "create", mint, name: "N", symbol: "N", traderPublicKey: "c", bondingCurveKey: "b" }), now);
    discovery.touchCandidate(mint, "market", { reason: "launch observed" }, now);
    const after = db.prepare("SELECT identity_state, state, ingress FROM candidates WHERE mint = ?").get(mint) as Record<string, string>;
    assert.equal(after.identity_state, "chain_validated");
    assert.equal(after.state, "watching");
    assert.deepEqual(JSON.parse(after.ingress).sort(), ["evidence", "market"]);
  });

  await t.test("material risk while research is busy: the protective exit still runs", () => {
    const s = coin();
    pf.onSignals(s, [fire]);
    tick();
    assert.ok(shadowLot(s.coin.mint));
    analystHealth.status = "running"; // a long model job is in progress
    s.screens = [{ id: "insiders", label: "Insider network", level: "veto", detail: "new insider cluster", status: "adverse" }];
    pf.portfolioTick();
    assert.equal(shadowLot(s.coin.mint)!.exiting, true, "a new thesis veto requests the exit without waiting for research");
    tick();
    assert.equal(shadowLot(s.coin.mint), undefined);
    analystHealth.status = "idle";
  });

  await t.test("overdue time exit after downtime: a current obligation, no invented offline fill", () => {
    const s = coin();
    pf.onSignals(s, [fire]);
    tick();
    const lot = shadowLot(s.coin.mint)!;
    // Worker down for an hour, past the 30-minute max hold; no quote while down.
    now += 3600_000;
    s.quote = { ...s.quote!, at: now - 3600_000 };
    pf.restorePortfolio();
    pf.portfolioTick();
    assert.ok(shadowLot(s.coin.mint), "nothing was sold while there was no price");
    assert.equal(pf.portfolioReport().closed.find((c) => c.id === lot.id), undefined);
    s.quote = { ...s.quote!, at: now };
    pf.portfolioTick(); // fresh price: the overdue time exit is requested now
    assert.equal(shadowLot(s.coin.mint)!.exiting, true);
    tick();
    const closed = pf.portfolioReport().closed.find((c) => c.id === lot.id)!;
    assert.equal(closed.exitReason, "Time stop");
    assert.ok(closed.closedAt >= now - 4_000, "the exit happened after recovery, at a current price");
  });

  await t.test("one exposure per mint: once the agent holds a coin, every later decision on it is busy, in any sleeve", () => {
    const s = coin();
    // Fresh required evidence so the agent's own decision admits the entry.
    s.holders = { at: now, totalHolders: 500, top: [], top10ExPoolPct: 15, insidersDetected: 0, insiderPct: 0, creatorPct: 0, mintAuthority: null, freezeAuthority: null, metadataMutable: false, lpLockedPct: 100, rugged: false, risks: [] };
    s.funding = { at: now, checked: 10, requested: 10, coverage: 1, fresh: 0, freshPct: 0, clusters: [], topClusterPct: 0, exchangeFunded: 0, unknownFunder: 0, payerOnly: 0, checkedPct: 15, unresolvedPct: 0, provider: "public" };
    const wide = { ...fire, plan: { ...fire.plan!, tp1Sol: 1.9e-6, tp2Sol: 2.4e-6 } };
    pf.onSignals(s, [wide]);
    assert.ok(pf.portfolioReport().pending.some((o) => o.account === "agent" && o.mint === s.coin.mint), "the agent entered");
    const snap = pf.buildSnapshot(s, { ...wide, setup: "intraday_retest" });
    assert.equal(snap.account.busy, true);
    assert.ok(pf.decide(s, { ...wide, setup: "intraday_retest" }).reasons.includes("Already in this coin"));
  });

  await t.test("a qualified stream that disconnects is reported degraded; nothing pretends it's live", () => {
    registerStreamStats(() => ({
      "pumpportal.new_token": { events: 10, lastEventAt: now - 120_000, connected: false, reconnects: 3, gapMs: 120_000 },
      "pumpportal.migration": { events: 1, lastEventAt: now - 300_000, connected: false, reconnects: 3, gapMs: 120_000 },
    }));
    const cap = capabilityReport().find((c) => c.id === "pumpportal.new_token")!;
    assert.equal(cap.state, "degraded");
    assert.equal(capabilityReport().find((c) => c.id === "pumpportal.token_trade")!.state, "unsupported");
  });
});
