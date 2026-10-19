// The five trading contexts from the Setuh study notes, as evidence checks over live features.
// A setup is ARMED when its structure has formed (the dump / base exists) and FIRES when the
// trigger confirms (sellers exhausted, buyers reclaiming). Numbers are priors to calibrate from
// the shadow book, not rules; see docs/trading-agent-design.md §2.3.
import { laneOf, type CoinState } from "./state";
import { CONFIG } from "./config";
import type { EpisodeView } from "./episodes";
import { narrativeSupport } from "./requirements";
import { atr, barsFor, coverageHours } from "./bars";
import { capabilityState } from "./capabilities";
import { narrativeEvidenceFor } from "./discovery";
import type { Features } from "./types";

export type SetupId =
  | "new_dump"
  | "stretch_deep"
  | "stretch_pullback"
  | "dev_base"
  | "migrated_base"
  | "early_momentum"
  | "first_shallow_pullback"
  | "migration_event"
  | "breakout_continuation"
  | "wallet_follow"
  | "intraday_retest"
  | "narrative_swing"
  | "narrative_position";

export const SETUP_LABEL: Record<SetupId, string> = {
  new_dump: "New pair · first dump",
  stretch_deep: "Final Stretch · deep selloff",
  stretch_pullback: "Final Stretch · pullback",
  dev_base: "Proven dev · base",
  migrated_base: "Migrated · bleed then base",
  early_momentum: "Fast · early momentum",
  first_shallow_pullback: "Fast · first shallow pullback",
  migration_event: "Fast · migration response",
  breakout_continuation: "Fast · breakout continuation",
  wallet_follow: "Experiment · follow tracked wallet",
  intraday_retest: "Intraday · range retest continuation",
  narrative_swing: "Swing · narrative and flow continuation",
  narrative_position: "Position · narrative persistence (gated)",
};

/** Funded sleeve (holding horizon) each strategy trades from. Horizons are intended ranges, not minimum holds. */
export type SleeveId = "fast" | "intraday" | "swing" | "position";
export const SETUP_SLEEVE: Record<SetupId, SleeveId> = {
  new_dump: "fast",
  stretch_deep: "fast",
  stretch_pullback: "fast",
  dev_base: "fast",
  migrated_base: "fast",
  early_momentum: "fast",
  first_shallow_pullback: "fast",
  migration_event: "fast",
  breakout_continuation: "fast",
  wallet_follow: "fast",
  intraday_retest: "intraday",
  narrative_swing: "swing",
  narrative_position: "position",
};

/**
 * Each strategy's data contract: what it needs and how fresh. Readiness is per strategy; a field one
 * strategy requires never becomes a global block for another.
 */
export const CONTRACTS: Record<SetupId, { maxTapeAgeMs: number | null; launchTape: boolean; entryTtlMs: number; family: "reversal" | "fast" }> = {
  new_dump: { maxTapeAgeMs: null, launchTape: true, entryTtlMs: 30_000, family: "reversal" },
  stretch_deep: { maxTapeAgeMs: null, launchTape: false, entryTtlMs: 30_000, family: "reversal" },
  stretch_pullback: { maxTapeAgeMs: null, launchTape: false, entryTtlMs: 30_000, family: "reversal" },
  dev_base: { maxTapeAgeMs: null, launchTape: true, entryTtlMs: 30_000, family: "reversal" },
  migrated_base: { maxTapeAgeMs: null, launchTape: false, entryTtlMs: 30_000, family: "reversal" },
  early_momentum: { maxTapeAgeMs: 20_000, launchTape: true, entryTtlMs: 20_000, family: "fast" },
  first_shallow_pullback: { maxTapeAgeMs: 20_000, launchTape: true, entryTtlMs: 20_000, family: "fast" },
  migration_event: { maxTapeAgeMs: 20_000, launchTape: false, entryTtlMs: 20_000, family: "fast" },
  breakout_continuation: { maxTapeAgeMs: 30_000, launchTape: false, entryTtlMs: 30_000, family: "fast" },
  wallet_follow: { maxTapeAgeMs: 20_000, launchTape: false, entryTtlMs: 15_000, family: "fast" },
  intraday_retest: { maxTapeAgeMs: 60_000, launchTape: false, entryTtlMs: 120_000, family: "fast" },
  narrative_swing: { maxTapeAgeMs: 120_000, launchTape: false, entryTtlMs: 10 * 60_000, family: "fast" },
  narrative_position: { maxTapeAgeMs: 300_000, launchTape: false, entryTtlMs: 30 * 60_000, family: "fast" },
};

/** Long-horizon data requirements (V2 §10). A strategy whose requirement isn't met is unsupported, not failing. */
export const HORIZON_REQUIREMENTS = {
  intraday_retest: { barMs: 5 * 60_000, minCompletedBars: 15, coverageHours: 1.25 },
  narrative_swing: { barMs: 15 * 60_000, minCompletedBars: 96, coverageHours: 24 },
  narrative_position: { barMs: 4 * 3600_000, minCompletedBars: 42, coverageHours: 7 * 24 },
};

export type Check = { label: string; ok: boolean; value: string };

export type Plan = {
  entrySol: number;
  stopSol: number;
  tp1Sol: number;
  tp2Sol: number;
  maxHoldMin: number;
  /** How long the entry signal stays valid for submission (an order can't submit after it). */
  entryTtlMs?: number;
  /** Bar-based trailing after TP1: lowest low of the last 3 completed bars minus `buffer`. */
  trail?: { barMs: number; buffer: number };
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

/**
 * Plan from market structure only: the stop is where the setup is invalidated, targets are levels the
 * market has shown (retracements of the move, the top of the range). Nothing is stretched to make the
 * numbers work; whether the trade pays after costs is decided later, and if it doesn't at this price
 * the agent waits for a better entry or lets the setup expire. Null if there's no target above entry.
 */
function plan(entry: number, stop: number, tp1: number, tp2: number, maxHoldMin: number): Plan | null {
  if (!(entry > stop) || !(tp1 > entry * 1.02)) return null;
  return { entrySol: entry, stopSol: stop, tp1Sol: tp1, tp2Sol: Math.max(tp2, tp1 * 1.05), maxHoldMin };
}
/** Price level `f` of the way from `lo` back up to `hi`. */
const retrace = (lo: number, hi: number, f: number) => lo + f * (hi - lo);

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
  const trig = [
    ...trigger,
    c("Target above entry (structure)", !!p, p ? `TP1 +${pct(p.tp1Sol / p.entrySol - 1)}` : "price already at the target level"),
    c("Stop within loss limit", riskOk, p ? pct((p.entrySol - p.stopSol) / p.entrySol) : "–"),
  ];
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
  // Dump bounce: first target the 38.2% retrace of the dump, second the 61.8%.
  return finish("new_dump", structure, trigger, plan(f.priceSol, f.lowSol * 0.93, retrace(f.lowSol, ath, 0.382), retrace(f.lowSol, ath, 0.618), 8));
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
  return finish("stretch_deep", structure, trigger, plan(f.priceSol, f.lowSol * 0.93, retrace(f.lowSol, ath, 0.382), retrace(f.lowSol, ath, 0.5), 12));
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
  // Ordinary pullback in a trend: first target the 61.8% retrace, second a retest just under the high.
  const high = f.athMcapSol / 1e9;
  return finish("stretch_pullback", structure, trigger, plan(f.priceSol, f.lowSol * 0.94, retrace(f.lowSol, high, 0.618), high * 0.97, 12));
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
  // Range trade: first target the top of the 10-minute range, second a measured move above it.
  return finish("dev_base", structure, trigger, plan(f.priceSol, f.lo10Sol * 0.92, f.hi10Sol, f.hi10Sol + (f.hi10Sol - f.lo10Sol), 15));
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
  return finish("migrated_base", structure, trigger, plan(f.priceSol, f.lo10Sol * 0.92, f.hi10Sol, f.hi10Sol + (f.hi10Sol - f.lo10Sol), 25));
}

/** All setups whose structure has formed for this coin, best first. */
// ---------- fast experiments (V2 §09): continuation and event strategies ----------

type Pt = { ts: number; p: number };
/** Price path from trades large enough to carry information (dust prints are ignored). */
const path = (s: CoinState): Pt[] => s.trades.filter((t) => t.sol >= 0.01 && t.priceSol > 0).map((t) => ({ ts: t.ts, p: t.priceSol }));
const maxP = (xs: Pt[]) => xs.reduce((m, x) => Math.max(m, x.p), 0);
const minP = (xs: Pt[]) => xs.reduce((m, x) => Math.min(m, x.p), Infinity);
const withTtl = (p: Plan | null, setup: SetupId) => (p ? { ...p, entryTtlMs: CONTRACTS[setup].entryTtlMs } : null);

/** Contract checks shared by the fast strategies: fresh tape, and the launch tape when required. */
function readiness(s: CoinState, f: Features, setup: SetupId): Check[] {
  const k = CONTRACTS[setup];
  const out: Check[] = [];
  if (k.maxTapeAgeMs !== null) {
    const age = s.lastPolledAt ? f.at - s.lastPolledAt : null;
    out.push(c(`Tape fresh (≤ ${k.maxTapeAgeMs / 1000}s)`, age !== null && age <= k.maxTapeAgeMs, age === null ? "not polled yet" : `${(age / 1000).toFixed(0)}s old`));
  }
  if (k.launchTape) out.push(c("Complete tape since launch", f.cohortsReliable, f.cohortsReliable ? "yes" : f.tapeFromLaunch ? `${f.tapeGaps} gaps` : "partial"));
  return out;
}

/** Initial expansion: participation and flow building, then a break above the launch range. */
function earlyMomentum(s: CoinState, f: Features): SetupEval | null {
  const pts = path(s);
  const before = pts.filter((x) => x.ts < f.at - 30_000);
  const priorHigh = maxP(before);
  const launchLow = minP(pts);
  const f60 = f.flow60s;
  const structure = [
    c("New pair, 1–15 minutes old", laneOf(s.coin, f.at) === "new" && between(f.ageMin, 1, 15), `${f.ageMin.toFixed(1)}m`),
    ...readiness(s, f, "early_momentum"),
    c("Launch range formed", before.length >= 10 && priorHigh > 0, `${before.length} prior trades`),
    c("Participation expanding", f60.buyers >= 8 && f60.buyers * 5 > f.flow5m.buyers, `${f60.buyers} buyers/60s vs ${f.flow5m.buyers}/5m`),
    c("Buying not concentrated", f60.buySol > 0 && f60.maxBuySol <= 0.4 * f60.buySol, f60.buySol ? `largest buy ${pct(f60.maxBuySol / f60.buySol)} of 60s` : "no buys"),
  ];
  const trigger = [
    c("Breaks above the launch range", f.priceSol > priorHigh, priorHigh ? `${pct(f.priceSol / priorHigh - 1)} vs prior high` : "–"),
    c("Not chased (≤ 8% above the level)", f.priceSol <= priorHigh * 1.08, priorHigh ? pct(f.priceSol / priorHigh - 1) : "–"),
    c("Buys ≥ 60% of 60s flow", buyShare(f60) >= 0.6, pct(buyShare(f60))),
    c("Net SOL in > 0.5", f60.netSol > 0.5, `${f60.netSol.toFixed(2)}◎`),
  ];
  const range = priorHigh - launchLow;
  return finish("early_momentum", structure, trigger, withTtl(plan(f.priceSol, priorHigh * 0.9, priorHigh + 0.5 * range, priorHigh + range, 3), "early_momentum"));
}

/**
 * The first pullback since launch after an initial impulse: INITIAL_IMPULSE → FIRST_PULLBACK →
 * HELD_STRUCTURE → RECLAIM. Needs the whole launch tape; a later pullback is never relabelled "first".
 */
function firstShallowPullback(s: CoinState, f: Features): SetupEval | null {
  const pts = path(s);
  let peakIdx = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i].p > pts[peakIdx].p) peakIdx = i;
  const peak = pts[peakIdx]?.p ?? 0;
  const start = minP(pts.slice(0, peakIdx + 1));
  const impulse = start > 0 ? peak / start - 1 : 0;
  // No earlier pullback of 15%+ on the way up (otherwise this isn't the first).
  let runMax = 0;
  let earlierDip = 0;
  for (const x of pts.slice(0, peakIdx + 1)) {
    runMax = Math.max(runMax, x.p);
    earlierDip = Math.max(earlierDip, 1 - x.p / runMax);
  }
  const after = pts.slice(peakIdx + 1);
  let lowIdx = -1;
  for (let i = 0; i < after.length; i++) if (lowIdx < 0 || after[i].p < after[lowIdx].p) lowIdx = i;
  const low = lowIdx >= 0 ? after[lowIdx].p : peak;
  const depth = peak ? 1 - low / peak : 0;
  const retraced = peak > start ? (peak - low) / (peak - start) : 1;
  // A bounce above the midpoint followed by another 10% drop would be a second pullback.
  const mid = low + 0.5 * (peak - low);
  const post = lowIdx >= 0 ? after.slice(lowIdx + 1) : [];
  let bounce = 0;
  let second = false;
  for (const x of post) {
    bounce = Math.max(bounce, x.p);
    if (bounce >= mid && x.p <= bounce * 0.9) second = true;
  }
  const lowAgeS = lowIdx >= 0 ? (f.at - after[lowIdx].ts) / 1000 : 0;
  const f60 = f.flow60s;
  const structure = [
    c("On the curve, ≤ 60 minutes old", (laneOf(s.coin, f.at) === "new" || laneOf(s.coin, f.at) === "stretch") && f.ageMin <= 60, `${f.ageMin.toFixed(0)}m`),
    ...readiness(s, f, "first_shallow_pullback"),
    c("Initial impulse ≥ 60%", impulse >= 0.6, pct(impulse)),
    c("No earlier 15% pullback on the way up", earlierDip < 0.15, pct(earlierDip)),
    c("Shallow pullback (12–40% off the peak)", between(depth, 0.12, 0.4), pct(depth)),
    c("Held: retraced ≤ half the impulse", retraced <= 0.5, pct(retraced)),
    c("Still the first pullback", !second, second ? "a second pullback formed" : "first"),
  ];
  const trigger = [
    c("Reclaimed half the pullback", f.priceSol >= mid, `${pct(f.priceSol / (mid || 1) - 1)} vs midpoint`),
    c("Low is ≥ 30s old", lowAgeS >= 30, `${lowAgeS.toFixed(0)}s`),
    c("Buys ≥ 60% of 60s flow", buyShare(f60) >= 0.6, pct(buyShare(f60))),
    c("≥ 5 buyers in 60s", f60.buyers >= 5, `${f60.buyers}`),
  ];
  return finish(
    "first_shallow_pullback",
    structure,
    trigger,
    withTtl(plan(f.priceSol, low * 0.95, peak * 0.99, peak + 0.5 * (peak - start), 10), "first_shallow_pullback"),
  );
}

/** Response to a verified migration: the new pool is usable and buyers hold the post-migration open. */
function migrationEvent(s: CoinState, f: Features): SetupEval | null {
  const at = s.coin.migratedAt ?? null;
  const verified = s.coin.migratedAtSource === "migration_stream" || s.coin.migratedAtSource === "pool_created";
  const pts = path(s);
  const postTrades = at ? pts.filter((x) => x.ts >= at) : [];
  const preHigh = at ? maxP(pts.filter((x) => x.ts < at)) || f.athMcapSol / 1e9 : 0;
  const postLow = minP(postTrades);
  const open = postTrades[0]?.p ?? 0;
  const f60 = f.flow60s;
  const ageMin = at ? (f.at - at) / 60_000 : null;
  const structure = [
    c("Migration time verified (stream or pool creation)", verified && at !== null, s.coin.migratedAtSource ?? "unknown"),
    c("Within 5 minutes of migration", ageMin !== null && between(ageMin, 0, 5), ageMin === null ? "–" : `${ageMin.toFixed(1)}m`),
    ...readiness(s, f, "migration_event"),
    c("Destination pool usable (liquidity ≥ $10k)", (f.liquidityUsd ?? 0) >= 10_000, `$${Math.round((f.liquidityUsd ?? 0) / 1000)}k`),
    c("≥ 10 trades in the new pool", postTrades.length >= 10, `${postTrades.length}`),
  ];
  const trigger = [
    c("Holding above the post-migration open", open > 0 && f.priceSol >= open, open ? pct(f.priceSol / open - 1) : "–"),
    c("Net SOL in", f60.netSol > 0, `${f60.netSol.toFixed(2)}◎`),
    c("≥ 5 buyers in 60s", f60.buyers >= 5, `${f60.buyers}`),
    c("Buys ≥ 55% of 60s flow", buyShare(f60) >= 0.55, pct(buyShare(f60))),
  ];
  return finish(
    "migration_event",
    structure,
    trigger,
    withTtl(plan(f.priceSol, postLow * 0.93, preHigh, preHigh + 0.5 * (preHigh - postLow), 5), "migration_event"),
  );
}

/** Escape from an established consolidation after an impulse (immediate-confirmation variant). */
function breakoutContinuation(s: CoinState, f: Features): SetupEval | null {
  const pts = path(s);
  const cons = pts.filter((x) => x.ts >= f.at - 6 * 60_000 && x.ts < f.at - 15_000);
  const imp = pts.filter((x) => x.ts >= f.at - 16 * 60_000 && x.ts < f.at - 6 * 60_000);
  const hi = maxP(cons);
  const lo = minP(cons);
  const height = cons.length ? hi / lo - 1 : 1;
  const span = cons.length ? (cons[cons.length - 1].ts - cons[0].ts) / 60_000 : 0;
  const impLo = minP(imp);
  const impHi = maxP(imp);
  const impulse = imp.length ? impHi / impLo - 1 : 0;
  const f60 = f.flow60s;
  const structure = [
    ...readiness(s, f, "breakout_continuation"),
    c("Prior impulse ≥ 40%", impulse >= 0.4, pct(impulse)),
    c("Consolidation 2–6 min, range ≤ 20%", span >= 2 && cons.length >= 10 && height <= 0.2, `${span.toFixed(1)}m, ${pct(height)}`),
    c("Range held above the impulse midpoint", lo >= impLo + 0.5 * (impHi - impLo), imp.length ? pct(lo / impLo - 1) : "–"),
  ];
  const trigger = [
    c("Breaks above the range", f.priceSol > hi, hi ? pct(f.priceSol / hi - 1) : "–"),
    c("Not chased (≤ 6% above)", f.priceSol <= hi * 1.06, hi ? pct(f.priceSol / hi - 1) : "–"),
    c("Buys ≥ 60% of 60s flow", buyShare(f60) >= 0.6, pct(buyShare(f60))),
    c("≥ 5 buyers in 60s", f60.buyers >= 5, `${f60.buyers}`),
  ];
  const h = hi - lo;
  return finish("breakout_continuation", structure, trigger, withTtl(plan(f.priceSol, lo * 0.97, hi + h, hi + 2 * h, 10), "breakout_continuation"));
}

// ---------- longer horizons (V2 §10) ----------

const median = (xs: number[]) => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : 0;
};

/**
 * Intraday retest continuation: a 5-minute close above the range frozen from the 12 bars before the
 * breakout, then a retest within 1–3 bars whose low enters [level − 0.5·ATR, level + 0.25·ATR] and closes
 * back above it, with positive flow and buyers at least the median of the 6 bars before. ATR(14) is frozen
 * from bars before the breakout. Triggers only while the retest bar is fresh (entry TTL 120s).
 */
function intradayRetest(s: CoinState, f: Features): SetupEval | null {
  const req = HORIZON_REQUIREMENTS.intraday_retest;
  const bars = barsFor(s, req.barMs, 3 * 3600_000, f.at);
  const usable = bars.filter((b) => b.state !== "missing");
  const structure: Check[] = [
    ...readiness(s, f, "intraday_retest"),
    c(`≥ ${req.minCompletedBars} completed 5m bars`, usable.length >= req.minCompletedBars, `${usable.length}`),
    c("Liquidity ≥ $10k", (f.liquidityUsd ?? 0) >= 10_000, `$${Math.round((f.liquidityUsd ?? 0) / 1000)}k`),
  ];
  if (!structure.every((x) => x.ok)) return null;
  // The retest is the latest completed bar; the breakout is 1–3 bars before it.
  const r = usable.length - 1;
  {
    for (let k = r - 1; k >= r - 3 && k >= 14; k--) {
      const range = usable.slice(k - 12, k);
      const level = Math.max(...range.map((b) => b.high));
      const a = atr(usable.slice(0, k), 14);
      if (!a || usable[k].close <= level) continue;
      const rb = usable[r];
      const inBand = rb.low >= level - 0.5 * a && rb.low <= level + 0.25 * a;
      const prior6 = usable.slice(r - 6, r).map((b) => b.buyers);
      const fresh = f.at - rb.end <= CONTRACTS.intraday_retest.entryTtlMs;
      const struct2 = [...structure, c("Breakout above the frozen 12-bar range", true, `close ${pct(usable[k].close / level - 1)} above`)];
      const trigger = [
        c("Retest low inside the ATR band", inBand, pct(rb.low / level - 1)),
        c("Retest closed back above the level", rb.close > level, pct(rb.close / level - 1)),
        c("Positive 5m net flow", rb.buySol - rb.sellSol > 0, `${(rb.buySol - rb.sellSol).toFixed(2)}◎`),
        c("Buyers ≥ median of 6 prior bars", rb.buyers >= median(prior6), `${rb.buyers} vs ${median(prior6)}`),
        c("Retest bar still fresh (entry TTL)", fresh, `${Math.round((f.at - rb.end) / 1000)}s`),
      ];
      const stop = rb.low - 0.25 * a;
      const risk = f.priceSol - stop;
      const p = risk > 0 ? plan(f.priceSol, stop, f.priceSol + 1.5 * risk, f.priceSol + 3 * risk, 360) : null;
      return finish("intraday_retest", struct2, trigger, p ? { ...p, entryTtlMs: CONTRACTS.intraday_retest.entryTtlMs, trail: { barMs: req.barMs, buffer: 0.25 * a } } : null);
    }
  }
  return null;
}

/**
 * Narrative swing: needs 24h of continuous 15-minute coverage AND independently supported narrative
 * evidence on a chain-validated mint, both available before the trigger. Hourly close above the frozen
 * 12-hour high, positive flow in 3 of the last 4 hours, then a 15-minute retest within 0.25·ATR.
 */
function narrativeSwing(s: CoinState, f: Features): SetupEval | null {
  const req = HORIZON_REQUIREMENTS.narrative_swing;
  const bars15 = barsFor(s, req.barMs, 26 * 3600_000, f.at);
  const cov = coverageHours(bars15);
  const ev = narrativeEvidenceFor(s.coin.mint);
  const structure: Check[] = [
    ...readiness(s, f, "narrative_swing"),
    c("24h continuous coverage", cov >= req.coverageHours, `${cov.toFixed(1)}h`),
    c("Narrative evidence: ≥ 2 independent origins on a validated mint", ev.chainValidated && ev.independentOrigins >= 2, `${ev.independentOrigins} origins`),
  ];
  if (!structure.every((x) => x.ok)) return null;
  const hourly = barsFor(s, 3600_000, 26 * 3600_000, f.at).filter((b) => b.state !== "missing");
  if (hourly.length < 14) return null;
  const k = hourly.length - 1;
  const level = Math.max(...hourly.slice(k - 12, k).map((b) => b.high));
  const flowUp = hourly.slice(-4).filter((b) => b.buySol > b.sellSol).length;
  const q = bars15.filter((b) => b.state !== "missing");
  const a = atr(q.slice(0, -1), 12);
  const rb = q[q.length - 1];
  const trigger = [
    c("Hourly close above the 12h high", hourly[k].close > level, pct(hourly[k].close / level - 1)),
    c("Positive flow in 3 of the last 4 hours", flowUp >= 3, `${flowUp}/4`),
    c("15m retest within 0.25·ATR of the level", !!a && Math.abs(rb.low - level) <= 0.25 * a && rb.close > level, a ? pct(rb.low / level - 1) : "–"),
  ];
  const stop = rb.low - 0.25 * (a ?? 0);
  const risk = f.priceSol - stop;
  const p = risk > 0 ? plan(f.priceSol, stop, f.priceSol + 2 * risk, f.priceSol + 4 * risk, 7 * 24 * 60) : null;
  return finish("narrative_swing", structure, trigger, p ? { ...p, entryTtlMs: CONTRACTS.narrative_swing.entryTtlMs, trail: { barMs: 3600_000, buffer: 0.25 * (a ?? 0) } } : null);
}

/** Readiness of each strategy's data contract right now, with the exact reason when unsupported. */
export function strategyReadiness(): { setup: SetupId; sleeve: SleeveId; state: "supported" | "unsupported"; reason: string }[] {
  const longest = Math.max(0, ...[...coinsForReadiness()].map((s) => coverageHours(barsFor(s, 15 * 60_000, 26 * 3600_000))));
  return (Object.keys(SETUP_SLEEVE) as SetupId[]).map((setup) => {
    const sleeve = SETUP_SLEEVE[setup];
    if (setup === "narrative_position")
      return { setup, sleeve, state: "unsupported" as const, reason: "Requires 7 days of complete 4-hour history and narrative persistence; free routes keep 24h of tape and coins are deep-watched briefly." };
    if (setup === "narrative_swing")
      return longest >= 24
        ? { setup, sleeve, state: "supported" as const, reason: "24h coverage available on at least one coin" }
        : { setup, sleeve, state: "unsupported" as const, reason: `Requires 24h continuous coverage; longest current coverage ${longest.toFixed(1)}h` };
    if (setup === "migration_event")
      return {
        setup,
        sleeve,
        state: "supported" as const,
        reason:
          capabilityState("pumpportal.migration") === "qualified"
            ? "Migration times from the live stream or pool creation"
            : "Migration times from pool creation only (stream migration not yet live-checked)",
      };
    return { setup, sleeve, state: "supported" as const, reason: "Contract checked per coin at decision time" };
  });
}
let coinsForReadiness: () => Iterable<CoinState> = () => [];
export const setReadinessUniverse = (fn: () => Iterable<CoinState>) => {
  coinsForReadiness = fn;
};

export function evaluateSetups(s: CoinState, dev: DevHistory): SetupEval[] {
  const f = s.features;
  if (!f || f.exhaustion === undefined) return [];
  const out = [
    newDump(s, f),
    stretchDeep(s, f),
    stretchPullback(s, f),
    devBase(s, f, dev),
    migratedBase(s, f),
    earlyMomentum(s, f),
    firstShallowPullback(s, f),
    migrationEvent(s, f),
    breakoutContinuation(s, f),
    intradayRetest(s, f),
    narrativeSwing(s, f),
  ].filter((x): x is SetupEval => x !== null);
  return out.sort((a, b) => (a.status === b.status ? b.quality - a.quality : a.status === "fire" ? -1 : 1));
}
