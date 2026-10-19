// Release A financial and control regressions (V2 spec §22): injected clock, controlled random draws,
// in-memory SQLite, no network. These verify engine behavior and accounting, not strategy profitability.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoinState } from "./state";
import type { SetupEval } from "./setups";

test("Release A regressions", async (t) => {
  process.env.AGENT_DB = ":memory:";
  const { db, saveCoin } = await import("./db");
  const { coins, ensureCoins } = await import("./state");
  const ledger = await import("./ledger");
  const pf = await import("./portfolio");
  const { executeCommand } = await import("./commands");

  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  // Execution draws are injected: each queued value is the next order's failure draw (default: success).
  let draws: number[] = [];
  pf.setDrawSource(() => ({ latency: 0.5, fail: draws.length ? draws.shift()! : 0.5 }));
  t.mock.method(Math, "random", () => 0.5);
  pf.restorePortfolio();

  const journalKinds = (kind: string) => db.prepare("SELECT data FROM journal WHERE kind = ?").all(kind).map((r) => JSON.parse((r as { data: string }).data));
  const cash = (id: "agent" | "rules" | "shadow" | "baseline") => pf.equityOf(id).cash;

  let n = 0;
  /** A migrated coin on a 100 SOL / 100M token pool (spot 1e-6 SOL). */
  function coin(): CoinState {
    const mint = `${String(++n).padStart(2, "0")}${"M".repeat(30)}`;
    const s = {
      coin: { mint, name: `Coin ${n}`, symbol: `C${n}`, creator: `creator${n}`, curve: "curve", pool: `pool${n}`, stage: "migrated", createdAt: now - 3600_000, migratedAt: now - 1800_000, socials: { twitter: null, website: null, telegram: null }, replies: 0, mcapUsd: 100_000, athMcapUsd: 150_000, curveProgress: 1, lastTradeAt: now, firstSeen: now - 3600_000, updatedAt: now },
      quote: { at: now, priceSol: 1e-6, priceUsd: 1.5e-4, liquidityUsd: 30_000, mcapUsd: 100_000, reserveTokens: 100_000_000, reserveSol: 100 },
      hot: true, hotSince: now, score: 1, trades: [], ids: new Set(), fromLaunch: false, backfilling: false, backfilled: true, nextPollAt: 0, tapeGaps: 0,
      holders: null, social: null, dev: null, funding: null, features: null, screens: [], setups: [], analysis: null,
    } as unknown as CoinState;
    coins.set(mint, s);
    saveCoin(s.coin);
    return s;
  }
  const fire = (stop = 0.85e-6): SetupEval => ({
    setup: "migrated_base", status: "fire", structure: [], trigger: [], quality: 1,
    plan: { entrySol: 1e-6, stopSol: stop, tp1Sol: 1.6e-6, tp2Sol: 2e-6, maxHoldMin: 60 },
  });
  const setPrice = (s: CoinState, price: number) => {
    // Re-centre the constant product at the new price.
    const k = 100 * 100_000_000;
    const tokens = Math.sqrt(k / price);
    s.quote = { ...s.quote!, at: now, priceSol: price, priceUsd: price * 150, reserveTokens: tokens, reserveSol: k / tokens };
  };
  const shadowPosition = (mint: string) => pf.portfolioReport().open.find((p) => p.account === "shadow" && p.mint === mint);
  const tick = (ms = 4_000) => {
    now += ms;
    for (const s of coins.values()) s.quote = { ...s.quote!, at: now };
    pf.portfolioTick();
  };

  await t.test("exactly one opening credit; cash is the ledger sum", () => {
    for (const id of ["agent", "rules", "shadow", "baseline"] as const) {
      assert.equal(ledger.ledgerEvents({ account: id }).filter((e) => e.type === "opening_capital").length, 1);
      assert.equal(cash(id), 10);
    }
    pf.restorePortfolio(); // a restart never credits again
    assert.equal(ledger.ledgerEvents({ account: "shadow" }).filter((e) => e.type === "opening_capital").length, 1);
    assert.ok(pf.reconciliationReport().ok, pf.reconciliationReport().issues.join("; "));
  });

  await t.test("entry invalidated during latency: no fill, no fee, no R", () => {
    const s = coin();
    pf.onSignals(s, [fire()]);
    assert.equal(pf.portfolioReport().pending.filter((o) => o.account === "shadow").length, 1);
    now += 4_000;
    setPrice(s, 0.8e-6); // below the 0.85e-6 stop before the order could submit
    pf.portfolioTick();
    assert.equal(shadowPosition(s.coin.mint), undefined);
    assert.equal(cash("shadow"), 10, "no fill and no fee");
    assert.ok(journalKinds("order_cancelled").some((x) => /invalidated before submission/.test(x.reason)));
    assert.equal(pf.reservedOf("shadow"), 0, "reservation released");
  });

  await t.test("adverse move after submission: R0 frozen, loss gives negative R, ledger reconciles", () => {
    const gapped = coin();
    pf.onSignals(gapped, [fire()]);
    tick(); // fills at ~1e-6
    const p = shadowPosition(gapped.coin.mint)!;
    assert.ok(p && p.r0Sol! > 0 && p.riskDefinitionVersion === "approved_plan_v2");
    const r0 = p.r0Sol!;
    now += 1000;
    setPrice(gapped, 0.6e-6); // gaps far through the stop
    pf.portfolioTick(); // places the stop exit
    tick(); // fills it
    const closed = pf.portfolioReport().closed.find((c) => c.id === p.id)!;
    assert.ok(closed.pnlSol < 0);
    assert.equal(closed.r0Sol, r0, "denominator unchanged by the gap");
    assert.ok(closed.r < -1, `a gapped loss is worse than −1R (got ${closed.r})`);
    assert.equal(closed.rValid, true);
    assert.ok(Math.abs(ledger.toSol(ledger.positionNetLamports(p.id)) - closed.pnlSol) < 2e-9, "PnL equals the ledger");
  });

  await t.test("TP1 fails then succeeds: inventory unchanged on failure, completed once on success", () => {
    const s = coin();
    pf.onSignals(s, [fire()]);
    tick();
    const p0 = shadowPosition(s.coin.mint)!;
    const before = cash("shadow");
    now += 1000;
    setPrice(s, 1.7e-6); // above TP1
    draws = [0.01]; // the TP1 sell's failure draw
    pf.portfolioTick();
    tick();
    let p = shadowPosition(s.coin.mint)!;
    assert.equal(p.tp1Done, false, "a failed TP1 sell does not complete TP1");
    assert.equal(p.tokens, p0.tokens, "inventory unchanged");
    assert.ok(Math.abs(cash("shadow") - (before - 0.0005)) < 1e-9, "the failed attempt's fee is charged once");
    assert.ok(Math.abs((p.feesSol ?? 0) - 0.0005) < 1e-12, "and attributed to the position");
    draws = [];
    now += 6_000; // past the 5s retry backoff
    setPrice(s, 1.7e-6);
    pf.portfolioTick(); // retry
    tick();
    p = shadowPosition(s.coin.mint)!;
    assert.equal(p.tp1Done, true);
    assert.ok(Math.abs(p.tokens - p0.tokens / 2) < 1e-6, "sold exactly the TP1 fraction");
    assert.ok(pf.reconciliationReport().ok, pf.reconciliationReport().issues.join("; "));
  });

  await t.test("finite exit retries: three failures exhaust the intent; restart doesn't reset it", () => {
    const s = coin();
    pf.onSignals(s, [fire()]);
    tick();
    const p0 = shadowPosition(s.coin.mint)!;
    const fees0 = p0.feesSol ?? 0;
    for (let i = 0; i < 3; i++) {
      draws = [0.01]; // every stop attempt fails
      now += 30_000;
      setPrice(s, 0.7e-6);
      pf.portfolioTick(); // place the stop exit
      now += 4_000;
      s.quote = { ...s.quote!, at: now };
      pf.portfolioTick(); // it fails
    }
    let p = shadowPosition(s.coin.mint)!;
    assert.equal(p.tokens, p0.tokens, "inventory unchanged");
    assert.ok(Math.abs((p.feesSol ?? 0) - fees0 - 3 * 0.0005) < 1e-12, "exactly three chargeable failures");
    pf.restorePortfolio(); // a restart keeps the exhausted budget
    draws = [];
    now += 60_000;
    setPrice(s, 0.7e-6);
    pf.portfolioTick();
    assert.equal(pf.portfolioReport().pending.filter((o) => o.side === "sell" && o.account === "shadow" && o.mint === s.coin.mint).length, 0, "no automatic fourth attempt");
    // An explicit operator request is a new intent with its own budget.
    assert.equal(pf.requestExit(p.id).status, "applied");
    now += 4_000;
    s.quote = { ...s.quote!, at: now };
    pf.portfolioTick();
    p = shadowPosition(s.coin.mint)!;
    assert.equal(p, undefined, "the operator exit filled and closed the lot");
    assert.ok(pf.reconciliationReport().ok, pf.reconciliationReport().issues.join("; "));
  });

  await t.test("insufficient funds: a funded account can't reserve more than it has", () => {
    // Bring the shadow book's cash down to 0.15 SOL with an explicit test adjustment.
    db.exec("BEGIN");
    ledger.post({ account: "shadow", type: "legacy_adjustment", cashLamports: -ledger.toLamports(pf.spendableOf("shadow") - 0.15), payload: { test: true } });
    db.exec("COMMIT");
    pf.restorePortfolio();
    const a = coin();
    const b = coin();
    pf.onSignals(a, [fire()]);
    pf.onSignals(b, [fire()]);
    const pending = pf.portfolioReport().pending.filter((o) => o.account === "shadow");
    assert.equal(pending.length, 1, "only one 0.1005 SOL reservation fits in 0.15 SOL");
    assert.ok(journalKinds("order_rejected").some((x) => x.account === "shadow" && x.code === "insufficient_funds"));
    assert.ok(pf.spendableOf("shadow") >= 0);
  });

  await t.test("old held market is restored on restart regardless of age", () => {
    // The position left open by the TP1 test (half sold) is an obligation.
    const open = pf.portfolioReport().open.find((x) => x.account === "shadow")!;
    assert.ok(open, "an open shadow position exists");
    const s = coins.get(open.mint)!;
    db.prepare("UPDATE coins SET updated_at = ? WHERE mint = ?").run(now - 7 * 3600_000, s.coin.mint);
    coins.delete(s.coin.mint);
    const missing = ensureCoins(pf.obligationMints());
    assert.deepEqual(missing, []);
    assert.ok(coins.has(s.coin.mint), "the held coin is back in memory");
  });

  await t.test("unknown valuation is incomplete, not a loss; drawdown follows reliable marks", () => {
    const p = pf.portfolioReport().open.find((x) => x.account === "shadow")!;
    const s = coins.get(p.mint)!;
    s.quote = { ...s.quote!, at: now - 5 * 60_000 }; // stale mark
    const e = pf.equityOf("shadow");
    assert.equal(e.complete, false);
    assert.equal(e.unpriced, 1);
    // Agent drawdown path 10 → 12 → 10 from cash alone (no positions, no signals needed).
    db.exec("BEGIN");
    ledger.post({ account: "agent", type: "legacy_adjustment", cashLamports: ledger.toLamports(2), payload: { test: true } });
    db.exec("COMMIT");
    pf.restorePortfolio();
    pf.portfolioTick();
    db.exec("BEGIN");
    ledger.post({ account: "agent", type: "legacy_adjustment", cashLamports: -ledger.toLamports(2), payload: { test: true } });
    db.exec("COMMIT");
    pf.restorePortfolio();
    pf.portfolioTick();
    assert.ok(Math.abs(pf.drawdownOf("agent")! - (1 - 10 / 12)) < 1e-9, `drawdown ${pf.drawdownOf("agent")}`);
  });

  await t.test("commands: idempotent, conflicting reuse rejected, resume keeps risk history", () => {
    const peakBefore = pf.walletSummary().peakEquity;
    const r1 = executeCommand({ commandId: "c-1", commandType: "pause_entries", payload: { reason: "test" } });
    assert.equal(r1.httpStatus, 200);
    assert.equal(r1.body.status, "applied");
    const again = executeCommand({ commandId: "c-1", commandType: "pause_entries", payload: { reason: "test" } });
    assert.equal(again.body.replayed, true, "an identical retry returns the recorded result");
    const conflict = executeCommand({ commandId: "c-1", commandType: "pause_entries", payload: { reason: "different" } });
    assert.equal(conflict.httpStatus, 409);
    assert.equal(pf.walletSummary().paused, "test");
    // The 10 → 12 → 10 drawdown (16.7%) breaches the 15% limit, so resume is blocked, not forced.
    const resume = executeCommand({ commandId: "c-2", commandType: "resume_entries" });
    assert.equal(resume.body.status, "blocked");
    assert.deepEqual(resume.body.reasonCodes, ["max_drawdown_breached"]);
    assert.equal(pf.walletSummary().peakEquity, peakBefore, "resume never resets the peak");
    const reset = executeCommand({ commandId: "c-3", commandType: "reset_risk_anchors" });
    assert.equal(reset.body.status, "applied");
    const resume2 = executeCommand({ commandId: "c-4", commandType: "resume_entries" });
    assert.equal(resume2.body.status, "applied");
    assert.equal(executeCommand({ commandId: "c-5", commandType: "nope" }).httpStatus, 422);
  });

  await t.test("a duplicate order outcome cannot be posted twice", () => {
    const before = ledger.cashLamports("baseline");
    db.exec("BEGIN");
    ledger.post({ account: "baseline", type: "buy_fill", cashLamports: -1, orderId: "dup-order", payload: {} });
    db.exec("COMMIT");
    assert.throws(() => ledger.post({ account: "baseline", type: "buy_fill", cashLamports: -1, orderId: "dup-order", payload: {} }));
    ledger.resetLedgerCache();
    pf.restorePortfolio();
    assert.equal(ledger.cashLamports("baseline"), before - 1, "only one movement exists");
  });

  await t.test("the books reconcile at the end", () => {
    const r = pf.reconciliationReport();
    assert.ok(r.ok, r.issues.join("; "));
  });
});
