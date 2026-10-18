// The agent's entry decision as a PURE function of a recorded snapshot (roadmap A3 + A4).
// Everything that influences the decision is in the snapshot, so a stored snapshot replays to the
// same result. Costs are modeled at the actual proposed size, on the actual reserves.
import { quoteBuy, quoteSell, type Pool } from "../src/lib/amm";
import { compareAnalysis } from "./analysis-impact";
import type { Analysis } from "./analyst";
import type { Plan, SetupId } from "./setups";
import type { AnalysisImpact } from "../src/lib/research-types";

export type ExecAssumptions = {
  /** Extra adverse move applied to every fill. */
  adverseSlippage: number;
  networkFeeSol: number;
  /** Largest acceptable own price impact on entry. */
  maxImpact: number;
  /** Stops are assumed to fill this much further away than planned (fast markets gap). */
  stopGap: number;
};

export type RiskParams = {
  riskPerTrade: number;
  maxPositionFraction: number;
  minOrderSol: number;
  maxOpen: number;
  maxWarnings: number;
  minEvidence: number;
  explorationRiskScale: number;
  noAnalysisScale: number;
  minEdgeR: number;
  minNetRewardRisk: number;
  sizingIterations: number;
};

export type EssentialCheck = { id: string; label: string; ok: boolean; detail: string };

export type DecisionSnapshot = {
  strategyVersion: string;
  at: number;
  mint: string;
  symbol: string;
  creator: string;
  setup: SetupId;
  plan: Plan;
  screens: { id: string; label: string; level: "veto" | "warn" | "ok" | "unknown"; status?: string }[];
  /** Evidence this setup cannot do without; a failed one defers the entry. */
  essentials: EssentialCheck[];
  /** What the benchmark has shown for this setup, from explicitly listed strategy versions. */
  evidence: { n: number; avgR: number; winRate: number; shrunkR: number; versions: string[] };
  account: { equity: number; cash: number; open: number; gate: string | null; busy: boolean; reentry: boolean; sameCreatorOpen: number };
  regime: { level: string; reasons: string[] };
  analysis: Analysis | null;
  pool: Pool | null;
  exec: ExecAssumptions;
  risk: RiskParams;
};

/** What this exact order would cost and return under the plan, net of fees, impact and slippage. */
export type CostModel = {
  sizeSol: number;
  spentSol: number;
  tokens: number;
  entryImpact: number;
  /** Everything sold at TP1 (conservative reward). */
  tp1NetSol: number;
  /** Half at TP1, half at TP2 (the plan's ladder). */
  planNetSol: number;
  /** Everything sold at the gapped stop (negative). */
  stopNetSol: number;
  netRewardRisk: number;
  /** Round-trip cost at TP1 as a fraction of size (fees + impact + slippage + network). */
  roundTripCostPct: number;
};

export type DecisionResult = {
  take: boolean;
  sizeSol: number;
  reasons: string[];
  ev: number;
  p: number;
  mode: "explore" | "evidence";
  n: number;
  analyst: { verdict: Analysis["verdict"] | "none"; conviction: number; note: string };
  regime: { level: string; reasons: string[] };
  impact: AnalysisImpact;
  costs: CostModel | null;
};

/** The pool as it would look with spot at `price` (same constant product). */
function poolAtPrice(pool: Pool, price: number): Pool {
  const k = pool.reserveSol * pool.reserveTokens;
  const reserveTokens = Math.sqrt(k / price);
  return { ...pool, reserveSol: k / reserveTokens, reserveTokens, spotPriceSol: price };
}

export function costModel(pool: Pool, plan: Plan, sizeSol: number, exec: ExecAssumptions): CostModel {
  const buy = quoteBuy(pool, sizeSol);
  const tokens = buy.tokensOut * (1 - exec.adverseSlippage);
  const spentSol = sizeSol + exec.networkFeeSol;
  // quoteSell already deducts the swap fee and the network fee.
  const sellAt = (price: number, qty: number) => quoteSell(poolAtPrice(pool, price), qty).solOut * (1 - exec.adverseSlippage);
  const risk = (plan.entrySol - plan.stopSol) / plan.entrySol;
  const tp1All = sellAt(plan.tp1Sol, tokens);
  const ladder = sellAt(plan.tp1Sol, tokens / 2) + sellAt(plan.tp2Sol, tokens / 2);
  const stopAll = sellAt(plan.entrySol * (1 - risk * exec.stopGap), tokens);
  const grossTp1 = sizeSol * (plan.tp1Sol / plan.entrySol);
  return {
    sizeSol,
    spentSol,
    tokens,
    entryImpact: buy.priceImpact,
    tp1NetSol: tp1All - spentSol,
    planNetSol: ladder - spentSol,
    stopNetSol: stopAll - spentSol,
    netRewardRisk: (tp1All - spentSol) / Math.max(1e-9, spentSol - stopAll),
    roundTripCostPct: grossTp1 ? (grossTp1 - tp1All + exec.networkFeeSol) / sizeSol : 0,
  };
}

const fmt = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(4)}◎`;

export function decideFrom(snap: DecisionSnapshot): DecisionResult {
  const { plan, risk: R, exec, account, evidence: evd } = snap;
  const reasons: string[] = [];
  const stopRisk = (plan.entrySol - plan.stopSol) / plan.entrySol;
  const mode: DecisionResult["mode"] = evd.n < R.minEvidence ? "explore" : "evidence";

  if (account.gate) reasons.push(account.gate);
  const vetoes = snap.screens.filter((x) => x.level === "veto");
  if (vetoes.length) reasons.push(`Screen veto: ${vetoes.map((x) => x.label).join(", ")}`);
  const warns = snap.screens.filter((x) => x.level === "warn");
  if (warns.length > R.maxWarnings) reasons.push(`${warns.length} screen warnings: ${warns.map((x) => x.label).join(", ")}`);
  const missing = snap.essentials.filter((e) => !e.ok);
  if (missing.length) reasons.push(`Missing essential evidence: ${missing.map((e) => `${e.label} (${e.detail})`).join("; ")}`);
  if (account.busy) reasons.push("Already in this coin");
  if (account.reentry) reasons.push("Re-entry cooldown");
  if (account.open >= R.maxOpen) reasons.push(`${account.open} positions open (max ${R.maxOpen})`);
  if (account.sameCreatorOpen > 0) reasons.push("Already exposed to this developer's coins");
  if (snap.regime.level === "bad") reasons.push(`Market regime bad: ${snap.regime.reasons.join("; ")}`);
  if (!snap.pool) reasons.push("No executable pool data");
  if (mode === "evidence" && evd.shrunkR < R.minEdgeR)
    reasons.push(`No edge yet: benchmark avg ${evd.avgR.toFixed(2)}R over ${evd.n} trades (${(evd.winRate * 100).toFixed(0)}% wins)`);

  const fresh = snap.analysis && snap.analysis.expiresAt > snap.at ? snap.analysis : null;
  const analyst = fresh
    ? { verdict: fresh.verdict, conviction: fresh.conviction, note: fresh.verdict === "reject" ? (fresh.redFlags[0] ?? fresh.thesis) : fresh.narrative }
    : { verdict: "none" as const, conviction: R.noAnalysisScale, note: "No fresh analyst verdict" };

  // Size so the modeled loss at the gapped stop (fees, impact, slippage included) equals the risk budget.
  const regimeScale = snap.regime.level === "caution" ? 0.5 : 1;
  const impactCap = snap.pool ? (snap.pool.reserveSol * exec.maxImpact) / (1 - exec.maxImpact) : 0;
  const sizeCap = Math.max(0, Math.min(account.equity * R.maxPositionFraction, impactCap, account.cash * 0.95));
  const sizeFor = (conviction: number) => {
    if (!snap.pool || sizeCap <= 0) return 0;
    const budget = account.equity * R.riskPerTrade * (mode === "explore" ? R.explorationRiskScale : 1) * conviction * regimeScale;
    let size = Math.min(sizeCap, budget / Math.max(0.01, stopRisk * exec.stopGap + 0.05));
    for (let i = 0; i < R.sizingIterations; i++) {
      const loss = -costModel(snap.pool, plan, size, exec).stopNetSol;
      if (loss <= 0) break;
      size = Math.min(sizeCap, size * (budget / loss));
    }
    return size;
  };
  // Net economics at the exact size: the target must pay for the round trip and beat the stop.
  const checksFor = (sizeSol: number) => {
    if (!snap.pool) return [];
    const m = costModel(snap.pool, plan, sizeSol, exec);
    if (m.tp1NetSol <= 0) return [`TP1 doesn't cover costs at ${sizeSol.toFixed(3)}◎ (net ${fmt(m.tp1NetSol)})`];
    if (m.netRewardRisk < R.minNetRewardRisk)
      return [`Net reward/risk ${m.netRewardRisk.toFixed(2)} below ${R.minNetRewardRisk} (TP1 ${fmt(m.tp1NetSol)} vs stop ${fmt(m.stopNetSol)})`];
    return [];
  };

  const { actual, impact } = compareAnalysis({
    mint: snap.mint,
    analysis: snap.analysis,
    now: snap.at,
    commonReasons: reasons,
    sizeFor,
    checksFor,
    defaultScale: R.noAnalysisScale,
    minimum: R.minOrderSol,
  });
  return {
    ...actual,
    ev: evd.shrunkR * stopRisk,
    p: evd.winRate,
    mode,
    n: evd.n,
    analyst,
    regime: snap.regime,
    impact,
    costs: snap.pool && actual.sizeSol > 0 ? costModel(snap.pool, plan, actual.sizeSol, exec) : null,
  };
}
