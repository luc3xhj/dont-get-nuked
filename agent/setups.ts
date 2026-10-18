// The five trading contexts from the Setuh study notes, as evidence checks over live features.
// A setup is ARMED when its structure has formed (the dump / base exists) and FIRES when the
// trigger confirms (sellers exhausted, buyers reclaiming). Numbers are priors to calibrate from
// the shadow book, not rules; see docs/trading-agent-design.md §2.3.
import { laneOf, type CoinState } from "./state";
import { CONFIG } from "./config";
import type { EpisodeView } from "./episodes";
import { narrativeSupport } from "./requirements";
import type { Features } from "./types";

export type SetupId = "new_dump" | "stretch_deep" | "stretch_pullback" | "dev_base" | "migrated_base";

export const SETUP_LABEL: Record<SetupId, string> = {
  new_dump: "New pair · first dump",
  stretch_deep: "Final Stretch · deep selloff",
  stretch_pullback: "Final Stretch · pullback",
  dev_base: "Proven dev · base",
  migrated_base: "Migrated · bleed then base",
};

export type Check = { label: string; ok: boolean; value: string };

export type Plan = {
  entrySol: number;
  stopSol: number;
  tp1Sol: number;
  tp2Sol: number;
  maxHoldMin: number;
};

export type SetupEval = {
  setup: SetupId;
  status: "armed" | "fire";
  structure: Check[];
  trigger: Check[];
  plan: Plan | null;
  /** 0–1: share of checks passing, weighted toward the trigger. */
  quality: number;
  /** The setup's episode (armed/fired/cooldown), attached by the episode tracker. */
  episode?: EpisodeView;
};

/** Creator history from coins we've observed ourselves (never assumed). */
export type DevHistory = {
  coins: number;
  /** Prior launches old enough for the outcome to be known. */
  resolved: number;
  successes: number;
  successRate: number;
  /** Conservative lower bound on the success rate. */
  lowerBound: number;
  proven: boolean;
  source: "pump.fun" | "observed";
};

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
const buyShare = (f: Features["flow60s"]) => (f.buySol + f.sellSol ? f.buySol / (f.buySol + f.sellSol) : 0);
const between = (v: number, lo: number, hi: number) => v >= lo && v <= hi;
const c = (label: string, ok: boolean, value: string): Check => ({ label, ok, value });

/** Scalp plan: structural stop below the low, first target at >= 1.5R (and a floor), second at a retrace level. */
function plan(entry: number, stop: number, tp2: number, maxHoldMin: number, minTp1 = 0.25): Plan {
  const risk = (entry - stop) / entry;
  const tp1 = entry * (1 + Math.max(minTp1, 1.5 * risk));
  return { entrySol: entry, stopSol: stop, tp1Sol: tp1, tp2Sol: Math.max(tp2, tp1 * 1.15), maxHoldMin };
}

/**
 * A curve that is ~90% full has little upside left to graduation but full downside, and graduation
 * is often where insider-heavy coins get dumped (playbook §4). Only buy that late if insiders are light.
 */
function graduationCheck(s: CoinState, f: Features): Check {
  const progress = s.coin.curveProgress ?? 0;
  if (progress < 0.9) return c("Not buying into graduation with heavy insiders", true, `curve ${pct(progress)}`);
  // Insider holdings are only measured with a complete tape; otherwise fall back to a fresh holder report.
  const h = s.holders && Date.now() - s.holders.at <= CONFIG.decision.holderReportMaxAgeMs ? s.holders : null;
  const top10 = h?.top10ExPoolPct ?? null;
  if (!f.cohortsReliable && top10 === null)
    return c("Not buying into graduation with heavy insiders", false, `curve ${pct(progress)}, insiders and holders unknown`);
  const insiders = f.cohortsReliable ? f.cohorts.insiders.heldPct : null;
  const heavy = (insiders !== null && insiders >= 5) || (top10 !== null && top10 >= 25);
  return c(
    "Not buying into graduation with heavy insiders",
    !heavy,
    `curve ${pct(progress)}, insiders ${insiders === null ? "unknown" : `${insiders.toFixed(1)}%`}, top-10 ${top10 === null ? "unknown" : `${top10.toFixed(0)}%`}`,
  );
}

const MAX_RISK = 0.3; // Setuh's "mental loss limit": skip setups whose structural stop is wider than this

function finish(setup: SetupId, structure: Check[], trigger: Check[], p: Plan | null): SetupEval | null {
  if (!structure.every((x) => x.ok)) return null;
  const riskOk = p ? (p.entrySol - p.stopSol) / p.entrySol <= MAX_RISK : false;
  const trig = [...trigger, c("Stop within loss limit", riskOk, p ? pct((p.entrySol - p.stopSol) / p.entrySol) : "–")];
  const passed = trig.filter((x) => x.ok).length;
  return {
    setup,
    status: trig.every((x) => x.ok) ? "fire" : "armed",
    structure,
    trigger: trig,
    plan: p,
    quality: 0.3 + 0.7 * (passed / trig.length),
  };
}

function newDump(s: CoinState, f: Features): SetupEval | null {
  const ins = f.cohorts.insiders;
  const structure = [
    c("New pair", laneOf(s.coin, f.at) === "new", `${f.ageMin.toFixed(0)}m old`),
    c("Had an impulse (ATH ≥ 70◎ mcap)", f.athMcapSol >= 70, `${f.athMcapSol.toFixed(0)}◎`),
    c("First dump 45–80% off ATH", between(f.maxDrawdown, 0.45, 0.8), pct(f.maxDrawdown)),
    c("Launch cohorts known", f.cohortsReliable, f.cohortsReliable ? "yes" : f.tapeFromLaunch ? `${f.tapeGaps} tape gaps` : "tape partial"),
    c(
      "Dev/snipers/bundles mostly out",
      f.cohortsReliable && (ins.soldFraction >= 0.5 || ins.heldPct <= 5),
      `sold ${pct(ins.soldFraction)}, hold ${ins.heldPct.toFixed(1)}%`,
    ),
  ];
  const f60 = f.flow60s;
  const trigger = [
    c("Sellers exhausted", (f.exhaustion ?? 0) >= 0.5, f.exhaustion === null ? "idle" : pct(f.exhaustion)),
    c("Bounced 6–35% off the low", between(f.bounceFromLow, 0.06, 0.35), pct(f.bounceFromLow)),
    c("≥ 5 buyers in 60s", f60.buyers >= 5, `${f60.buyers}`),
    c("Buys ≥ 60% of 60s flow", buyShare(f60) >= 0.6, pct(buyShare(f60))),
    c("Net SOL in", f60.netSol > 0.3, `${f60.netSol.toFixed(2)}◎`),
  ];
  const ath = f.athMcapSol / 1e9;
  return finish("new_dump", structure, trigger, plan(f.priceSol, f.lowSol * 0.93, f.lowSol + 0.6 * (ath - f.lowSol), 8));
}

function stretchDeep(s: CoinState, f: Features): SetupEval | null {
  const structure = [
    c("Final Stretch", laneOf(s.coin, f.at) === "stretch", `curve ${pct(s.coin.curveProgress ?? 0)}`),
    c("Deep selloff 55–85%", between(f.maxDrawdown, 0.55, 0.85), pct(f.maxDrawdown)),
    c("A big holder dumped (≥ 1.5%)", f.topSellerPct >= 1.5, `${f.topSellerPct.toFixed(1)}% of supply`),
    c("…and stopped selling", !f.topSellerActive, f.topSellerActive ? "still selling" : "quiet 60s"),
    c("Range held ≥ 2m", f.baseMin >= 2 && f.lowAgeMin >= 2, `${f.baseMin.toFixed(1)}m`),
    graduationCheck(s, f),
  ];
  const f60 = f.flow60s;
  const trigger = [
    c("Higher low", f.higherLow, f.higherLow ? "yes" : "no"),
    c("New wallets buying (≥ 40%)", f60.newBuyerShare >= 0.4, pct(f60.newBuyerShare)),
    c("Buys ≥ 55% of 60s flow", buyShare(f60) >= 0.55, pct(buyShare(f60))),
    c("≥ 4 buyers in 60s", f60.buyers >= 4, `${f60.buyers}`),
    c("Bounce 5–40%", between(f.bounceFromLow, 0.05, 0.4), pct(f.bounceFromLow)),
  ];
  const ath = f.athMcapSol / 1e9;
  return finish("stretch_deep", structure, trigger, plan(f.priceSol, f.lowSol * 0.93, f.lowSol + 0.5 * (ath - f.lowSol), 12));
}

function stretchPullback(s: CoinState, f: Features): SetupEval | null {
  const narrative = narrativeSupport(s);
  const structure = [
    c("Final Stretch", laneOf(s.coin, f.at) === "stretch", `curve ${pct(s.coin.curveProgress ?? 0)}`),
    c("Ordinary pullback 35–55%", between(f.maxDrawdown, 0.35, 0.55), pct(f.maxDrawdown)),
    c("Low is ≥ 1m old", f.lowAgeMin >= 1, `${f.lowAgeMin.toFixed(1)}m`),
    graduationCheck(s, f),
  ];
  const f60 = f.flow60s;
  const trigger = [
    c("Sellers exhausted", (f.exhaustion ?? 0) >= 0.5, f.exhaustion === null ? "idle" : pct(f.exhaustion)),
    c("Bounce 5–25%", between(f.bounceFromLow, 0.05, 0.25), pct(f.bounceFromLow)),
    // A link is not a narrative: the content behind it must be readable and fresh.
    c("Narrative evidence (readable, fresh)", narrative.ok, narrative.detail),
    c("Buys ≥ 60% of 60s flow", buyShare(f60) >= 0.6, pct(buyShare(f60))),
    c("≥ 5 buyers in 60s", f60.buyers >= 5, `${f60.buyers}`),
  ];
  return finish("stretch_pullback", structure, trigger, plan(f.priceSol, f.lowSol * 0.94, (f.athMcapSol / 1e9) * 0.95, 12, 0.2));
}

function devBase(s: CoinState, f: Features, dev: DevHistory): SetupEval | null {
  const lane = laneOf(s.coin, f.at);
  const structure = [
    // "Proven" needs a real hit rate, not one lucky coin among dozens of launches.
    c(
      "Proven developer",
      dev.proven,
      `${dev.successes} of ${dev.resolved} resolved prior coins succeeded (≥ ${pct(dev.lowerBound)} at 95%, ${dev.source})`,
    ),
    c("On the curve", lane === "new" || lane === "stretch", lane ?? "–"),
    c("Sideways (10m range ≤ 25%)", f.range10m <= 0.25, pct(f.range10m)),
    c("Base ≥ 2m", f.baseMin >= 2, `${f.baseMin.toFixed(1)}m`),
    c(
      "Early supply absorbed (insiders ≤ 10%)",
      f.cohortsReliable && f.cohorts.insiders.heldPct <= 10,
      f.cohortsReliable ? `${f.cohorts.insiders.heldPct.toFixed(1)}%` : "unknown (tape incomplete)",
    ),
  ];
  const f60 = f.flow60s;
  const nearLow = f.priceSol <= f.lo10Sol + 0.4 * (f.hi10Sol - f.lo10Sol);
  const trigger = [
    c("Near range low", nearLow, `${pct(f.lo10Sol ? f.priceSol / f.lo10Sol - 1 : 0)} above low`),
    c("Net SOL in", f60.netSol > 0, `${f60.netSol.toFixed(2)}◎`),
    c("≥ 3 buyers in 60s", f60.buyers >= 3, `${f60.buyers}`),
  ];
  return finish("dev_base", structure, trigger, plan(f.priceSol, f.lo10Sol * 0.92, f.priceSol * 1.6, 15));
}

function migratedBase(s: CoinState, f: Features): SetupEval | null {
  const mcapUsd = s.quote?.mcapUsd ?? 0;
  const structure = [
    c(
      "Migrated 45m–6h ago",
      laneOf(s.coin, f.at) === "migrated" && f.migratedAgeMin !== null && between(f.migratedAgeMin, 45, 360),
      f.migratedAgeMin === null ? "migration time unknown" : `migrated ${f.migratedAgeMin.toFixed(0)}m ago`,
    ),
    c("Bled ≥ 60% from ATH", f.maxDrawdown >= 0.6, pct(f.maxDrawdown)),
    c("MCap $15k–120k", between(mcapUsd, 15_000, 120_000), `$${Math.round(mcapUsd / 1000)}k`),
    c("Liquidity ≥ $10k", (f.liquidityUsd ?? 0) >= 10_000, `$${Math.round((f.liquidityUsd ?? 0) / 1000)}k`),
    c("Base ≥ 10m, range ≤ 30%", f.baseMin >= 10 && f.range10m <= 0.3, `${f.baseMin.toFixed(0)}m, ${pct(f.range10m)}`),
  ];
  const f60 = f.flow60s;
  const nearLow = f.priceSol <= f.lo10Sol + 0.4 * (f.hi10Sol - f.lo10Sol);
  const trigger = [
    c("Near range low", nearLow, `${pct(f.lo10Sol ? f.priceSol / f.lo10Sol - 1 : 0)} above low`),
    c("Net SOL in", f60.netSol > 0, `${f60.netSol.toFixed(2)}◎`),
    c("≥ 3 buyers in 60s", f60.buyers >= 3, `${f60.buyers}`),
  ];
  return finish("migrated_base", structure, trigger, plan(f.priceSol, f.lo10Sol * 0.92, Math.max(f.hi10Sol * 1.15, f.priceSol * 1.5), 25));
}

/** All setups whose structure has formed for this coin, best first. */
export function evaluateSetups(s: CoinState, dev: DevHistory): SetupEval[] {
  const f = s.features;
  if (!f || f.exhaustion === undefined) return [];
  const out = [newDump(s, f), stretchDeep(s, f), stretchPullback(s, f), devBase(s, f, dev), migratedBase(s, f)].filter(
    (x): x is SetupEval => x !== null,
  );
  return out.sort((a, b) => (a.status === b.status ? b.quality - a.quality : a.status === "fire" ? -1 : 1));
}
