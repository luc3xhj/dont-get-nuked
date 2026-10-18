import assert from "node:assert/strict";
import test from "node:test";
import { costModel, decideFrom, type DecisionSnapshot } from "./decision";
import { wilsonLower } from "./stats";

const now = 1_800_000_000_000;
const base = (): DecisionSnapshot => ({
  strategyVersion: "test",
  at: now,
  mint: "M".repeat(32),
  symbol: "TST",
  creator: "creator",
  setup: "migrated_base",
  plan: { entrySol: 1e-6, stopSol: 0.85e-6, tp1Sol: 1.5e-6, tp2Sol: 2e-6, maxHoldMin: 20 },
  screens: [],
  essentials: [{ id: "holders", label: "Holder report", ok: true, detail: "1m old" }],
  evidence: { n: 0, avgR: 0, winRate: 0, shrunkR: 0, versions: ["test"] },
  account: { equity: 10, cash: 10, open: 0, gate: null, busy: false, reentry: false, sameCreatorOpen: 0 },
  regime: { level: "ok", reasons: [] },
  analysis: null,
  pool: { reserveSol: 80, reserveTokens: 80e6, spotPriceSol: 1e-6, fee: 0.005, curveTokensLeft: null },
  exec: { adverseSlippage: 0.01, networkFeeSol: 0.0005, maxImpact: 0.02, stopGap: 1.2 },
  risk: {
    riskPerTrade: 0.01,
    maxPositionFraction: 0.12,
    minOrderSol: 0.05,
    maxOpen: 4,
    maxWarnings: 2,
    minEvidence: 15,
    explorationRiskScale: 0.5,
    noAnalysisScale: 0.5,
    minEdgeR: 0.05,
    minNetRewardRisk: 1,
    sizingIterations: 4,
  },
});

test("a recorded snapshot replays to the same decision", () => {
  const snap = base();
  const a = decideFrom(JSON.parse(JSON.stringify(snap)));
  const b = decideFrom(JSON.parse(JSON.stringify(snap)));
  assert.deepEqual(a, b);
  assert.equal(a.take, true);
});

test("size is set so the modeled loss at the gapped stop matches the risk budget", () => {
  const d = decideFrom(base());
  const budget = 10 * 0.01 * 0.5 * 0.5; // equity × risk × explore × no-analysis
  assert.ok(d.costs);
  assert.ok(Math.abs(-d.costs.stopNetSol - budget) / budget < 0.05, `loss ${-d.costs.stopNetSol} vs budget ${budget}`);
});

test("rejects when the target doesn't pay for costs at the proposed size", () => {
  const snap = base();
  snap.plan = { ...snap.plan, tp1Sol: 1.02e-6, tp2Sol: 1.05e-6 };
  const d = decideFrom(snap);
  assert.equal(d.take, false);
  assert.match(d.reasons.join(" "), /doesn't cover costs|reward\/risk/);
});

test("costs grow with size on the same pool", () => {
  const snap = base();
  const small = costModel(snap.pool!, snap.plan, 0.05, snap.exec);
  const large = costModel(snap.pool!, snap.plan, 1.5, snap.exec);
  assert.ok(large.roundTripCostPct > small.roundTripCostPct);
});

test("missing essential evidence defers the entry", () => {
  const snap = base();
  snap.essentials = [{ id: "funding", label: "Top-holder funding", ok: false, detail: "not checked" }];
  const d = decideFrom(snap);
  assert.equal(d.take, false);
  assert.match(d.reasons.join(" "), /Missing essential evidence: Top-holder funding/);
});

test("exposure to the same developer blocks a second entry", () => {
  const snap = base();
  snap.account.sameCreatorOpen = 1;
  assert.equal(decideFrom(snap).take, false);
});

test("Wilson lower bound keeps small samples conservative", () => {
  assert.equal(wilsonLower(0, 0), 0);
  assert.ok(wilsonLower(2, 2) < 0.6);
  assert.ok(wilsonLower(1, 3) < 0.15);
  assert.ok(wilsonLower(3, 3) >= 0.15);
});
