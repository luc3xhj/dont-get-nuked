import assert from "node:assert/strict";
import { test } from "node:test";

test("sleeves and bars: zero-sum allocation, no implicit borrowing, completed bars only", async (t) => {
  process.env.AGENT_DB = ":memory:";
  const pf = await import("./portfolio");
  const ledger = await import("./ledger");
  const { buildBars, atr } = await import("./bars");
  const now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  pf.restorePortfolio();

  await t.test("one opening credit; the sleeve plan changes attribution, not cash", () => {
    const v = pf.sleevesOf("agent")!;
    assert.equal(pf.equityOf("agent").cash, 10);
    assert.equal(v.sleeves.find((x) => x.sleeve === "fast")!.cashSol, 6);
    assert.equal(v.sleeves.find((x) => x.sleeve === "intraday")!.cashSol, 3);
    assert.equal(v.sleeves.find((x) => x.sleeve === "swing")!.cashSol, 0);
    assert.ok(Math.abs(v.unallocatedSol - 1) < 1e-9);
    assert.equal(ledger.ledgerEvents({ account: "agent" }).filter((e) => e.type === "opening_capital").length, 1);
    assert.equal(pf.sleevesOf("shadow"), null, "benchmarks are not partitioned");
  });

  await t.test("no implicit borrowing; reallocation is explicit and bounded", () => {
    assert.equal(pf.sleeveSpendable("agent", "swing"), 0, "an unfunded sleeve can't trade even though the account has cash");
    const blocked = pf.reallocate("agent", "intraday", "swing", 5);
    assert.equal(blocked.status, "blocked");
    assert.deepEqual(blocked.reasonCodes, ["insufficient_unreserved_cash"]);
    const ok = pf.reallocate("agent", "intraday", "swing", 1);
    assert.equal(ok.status, "applied");
    assert.equal(pf.sleeveSpendable("agent", "swing"), 1);
    assert.equal(pf.sleeveSpendable("agent", "intraday"), 2);
    assert.equal(pf.equityOf("agent").cash, 10, "zero account cash delta");
    assert.ok(pf.reconciliationReport().ok, pf.reconciliationReport().issues.join("; "));
  });

  await t.test("bars: incomplete bars excluded, missing differs from empty, ATR from usable bars", () => {
    const m = 60_000;
    const base = Math.floor(now / m) * m - 10 * m;
    const pts = [
      { ts: base + 5_000, priceSol: 1, side: "buy" as const, sol: 1, wallet: "a" },
      { ts: base + 20_000, priceSol: 1.2, side: "sell" as const, sol: 1, wallet: "b" },
      { ts: base + 2 * m + 1_000, priceSol: 1.1, side: "buy" as const, sol: 1, wallet: "c" },
      { ts: now + 20_000, priceSol: 9, side: "buy" as const, sol: 1, wallet: "d" }, // in the still-open bar
    ];
    const at = now + 30_000; // mid-bar: [now, now + 1m) hasn't completed
    const bars = buildBars(pts, m, base - 2 * m, at, base);
    assert.equal(bars[0].state, "missing", "before coverage starts");
    const first = bars.find((b) => b.start === base)!;
    assert.equal(first.state, "ok");
    assert.equal(first.high, 1.2);
    assert.equal(bars.find((b) => b.start === base + m)!.state, "empty", "covered but no trades");
    assert.ok(bars.every((b) => b.end <= at), "the open bar is never included");
    assert.ok(!bars.some((b) => b.high === 9));
    assert.ok(atr(bars, 3) !== null);
  });
});
