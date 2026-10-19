// Paper accounts, decisions, orders, position management and risk.
//   agent    — the strategy: screens + EV after costs + risk sizing + portfolio limits
//   shadow   — takes EVERY setup that fires at a fixed size: measures each setup's raw edge
//   baseline — whenever shadow enters, enters a RANDOM other hot coin with the same plan shape:
//              if setups can't beat this, we have no edge
import { NETWORK_FEE_SOL } from "../src/lib/amm";
import { CONFIG } from "./config";
import { db, journal } from "./db";
import { costModel, decideFrom, POST_TP1_STOP, TP1_FRACTION, type DecisionResult, type DecisionSnapshot } from "./decision";
import {
  allocate,
  cashLamports,
  ensureSleeveColumn,
  hasAllocations,
  hasOpening,
  positionNetLamports,
  post,
  resetLedgerCache,
  sleeveCashLamports,
  toLamports,
  toSol,
} from "./ledger";
import { EXEC, fillBuy, fillSell, latency, liquidationValue, poolOf, seededRandom } from "./execution";
import { essentialsFor } from "./requirements";
import { barsFor } from "./bars";
import { CONTRACTS, SETUP_LABEL, SETUP_SLEEVE, type Plan, type SetupEval, type SetupId, type SleeveId } from "./setups";
import type { Trade } from "./types";
import type { Analysis } from "./analyst";
import { regime } from "./regime";
import { coins, type CoinState } from "./state";
import { analysisKey } from "./analysis-impact";

/**
 * agent: the strategy with research · rules: the same policy on the same opportunities with research removed
 * (measures research's net contribution) · shadow: every fired setup at a fixed size · baseline: random coins.
 * Each is a separately funded paper account with its own opening credit.
 */
export type AccountId = "agent" | "rules" | "shadow" | "baseline" | "follower";

export const RISK = {
  startCash: 10,
  /** Equity risked per trade (stop distance + costs). */
  riskPerTrade: 0.01,
  maxPositionFraction: 0.12,
  minOrderSol: 0.05,
  maxImpact: 0.02,
  maxOpen: 4,
  dailyLossLimit: 0.05,
  maxDrawdown: 0.15,
  lossStreakCooldown: { losses: 3, ms: 15 * 60_000 },
  reentryCooldownMs: 20 * 60_000,
  maxWarnings: 2,
  fixedSizeSol: 0.1,
  /** Shrink a setup's measured avg R toward zero with this many pseudo-trades. */
  priorWeight: 10,
  /** Below this many shadow trades a setup is "exploring": the agent trades it at reduced risk. */
  minEvidence: 15,
  explorationRiskScale: 0.5,
  /** Size multiplier when the analyst hasn't judged the coin yet. */
  noAnalysisScale: 0.5,
  /** Required shrunk avg R (after costs) once a setup has evidence. */
  minEdgeR: 0.05,
  /** Assume stops gap this much past the stop price in a fast market. */
  stopGap: 1.2,
  /** Open positions (incl. pending buys) allowed per developer: their coins tend to move together. */
  maxPerCreator: 1,
  trailPct: 0.25,
};

type Account = {
  id: AccountId;
  cash: number;
  peakEquity: number;
  dayKey: string;
  dayStartEquity: number;
  lossStreak: number;
  cooldownUntil: number;
  paused: string | null;
};

export type Position = {
  id: string;
  account: AccountId;
  mint: string;
  symbol: string;
  setup: SetupId | "random";
  openedAt: number;
  entryPriceSol: number;
  tokens: number;
  initialTokens: number;
  costSol: number;
  proceedsSol: number;
  plan: Plan;
  stopSol: number;
  tp1Done: boolean;
  highSol: number;
  liquidityAtEntry: number | null;
  /** Screen vetoes already present at entry; only new ones trigger a thesis exit. */
  entryVetoes: string[];
  /** Analyst verdict when the position opened ("none" if there wasn't a fresh one). */
  analystAtEntry: Analysis["verdict"] | "none";
  entryAnalysisId?: string | null;
  entryDecisionId?: string;
  exitAnalysisId?: string | null;
  evidence: string[];
  exiting: boolean;
  creator?: string;
  /** Strategy version that opened the position. */
  version?: string;
  /**
   * Initial risk R0 (approved_plan_v2): the modeled net loss at the original structural stop for the approved
   * size, frozen before submission. Strictly positive and never changed afterwards; R = net PnL ÷ R0.
   */
  r0Sol?: number;
  riskDefinitionVersion?: "approved_plan_v2" | "legacy_v1";
  /** Fees of failed exit attempts on this position (they are part of its net PnL). */
  feesSol?: number;
  /** Follower experiment: the tracked wallet whose observed buy triggered this lot. */
  leader?: string;
  /** Funded sleeve (immutable) and the sleeve currently managing the lot (management transfer is disabled). */
  sleeveId?: SleeveId;
  managementSleeveId?: SleeveId;
};

export type Closed = {
  id: string;
  account: AccountId;
  mint: string;
  symbol: string;
  setup: SetupId | "random";
  openedAt: number;
  closedAt: number;
  costSol: number;
  proceedsSol: number;
  pnlSol: number;
  pnlPct: number;
  /** PnL in units of the planned risk (entry→stop). */
  r: number;
  exitReason: string;
  holdMin: number;
  analystAtEntry: Analysis["verdict"] | "none";
  entryAnalysisId?: string | null;
  entryDecisionId?: string;
  exitAnalysisId?: string | null;
  version?: string;
  r0Sol?: number;
  feesSol?: number;
  riskDefinitionVersion?: "approved_plan_v2" | "legacy_v1";
  /** False when the legacy risk denominator was not positive (the cash result stands; R is unusable). */
  rValid?: boolean;
};

type Order = {
  id: string;
  decisionId?: string;
  analysisId?: string | null;
  analystVerdict?: Analysis["verdict"] | "none";
  account: AccountId;
  mint: string;
  side: "buy" | "sell";
  createdAt: number;
  notBefore: number;
  decisionPriceSol: number;
  solIn?: number;
  tokensIn?: number;
  positionId?: string;
  reason: string;
  // Buy orders carry what the position needs once filled.
  setup?: SetupId | "random";
  plan?: Plan;
  evidence?: string[];
  version?: string;
  /** Uniform draws fixed when the order is placed (latency, failure), so a recorded order replays identically. */
  draws?: { latency: number; fail: number };
  /** Set once a sell has waited past the timeout without a fresh price (journaled once). */
  waitingSince?: number;
  /** A TP1 sell: the position only counts TP1 as done (and moves its stop) once this fills. */
  kind?: "tp1";
  /** Cash held back for a pending buy (amount + network fee); released when the order ends. */
  reserveSol?: number;
  /** Frozen planned risk for the lot this buy would open. */
  r0Sol?: number;
  /** The order can't be submitted at or after this time (entry orders: the signal's validity). */
  submitBy?: number;
  /** Follower experiment: the tracked wallet whose buy triggered this order. */
  leader?: string;
  sleeve?: SleeveId;
};

// ---------- persistence ----------

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS positions (id TEXT PRIMARY KEY, account TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS closed (id TEXT PRIMARY KEY, account TEXT NOT NULL, setup TEXT NOT NULL, closed_at INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS closed_account ON closed (account, closed_at);
  CREATE TABLE IF NOT EXISTS equity (account TEXT NOT NULL, ts INTEGER NOT NULL, equity REAL NOT NULL, PRIMARY KEY (account, ts)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, at INTEGER NOT NULL, mint TEXT NOT NULL, version TEXT NOT NULL, snapshot TEXT NOT NULL, result TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS decisions_at ON decisions (at);
  -- The rules-only comparator's decision on the same opportunity (opportunity_id = the agent decision id).
  CREATE TABLE IF NOT EXISTS comparator_decisions (id TEXT PRIMARY KEY, opportunity_id TEXT NOT NULL, account TEXT NOT NULL, at INTEGER NOT NULL, snapshot TEXT NOT NULL, result TEXT NOT NULL);
`);

const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const IDS: AccountId[] = ["agent", "rules", "shadow", "baseline", "follower"];

const accounts = new Map<AccountId, Account>();
const positions = new Map<string, Position>();
const orders: Order[] = [];
const lastExit = new Map<string, number>(); // `${account}:${mint}` -> closedAt
const lastShadow = new Map<string, number>(); // `${mint}:${setup}` -> openedAt
const lastDecision = new Map<string, number>(); // `${mint}:${setup}` -> decidedAt

const saveAccount = (a: Account) => db.prepare("INSERT OR REPLACE INTO accounts (id, data) VALUES (?, ?)").run(a.id, JSON.stringify(a));
const savePosition = (p: Position) =>
  db.prepare("INSERT OR REPLACE INTO positions (id, account, data) VALUES (?, ?, ?)").run(p.id, p.account, JSON.stringify(p));
const deletePosition = (id: string) => db.prepare("DELETE FROM positions WHERE id = ?").run(id);
const saveOrder = (o: Order) => db.prepare("INSERT OR REPLACE INTO orders (id, data) VALUES (?, ?)").run(o.id, JSON.stringify(o));
const deleteOrder = (id: string) => db.prepare("DELETE FROM orders WHERE id = ?").run(id);
function addOrder(o: Order) {
  orders.push(o);
  saveOrder(o);
}
function removeOrder(i: number) {
  deleteOrder(orders[i].id);
  orders.splice(i, 1);
}

/** Apply one fill's account, position and journal writes together, or not at all. */
function atomically(fn: () => void) {
  db.exec("BEGIN");
  try {
    fn();
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function restorePortfolio() {
  for (const row of db.prepare("SELECT data FROM accounts").all() as { data: string }[]) {
    const a = JSON.parse(row.data) as Account;
    accounts.set(a.id, a);
  }
  resetLedgerCache();
  for (const id of IDS)
    if (!accounts.has(id)) {
      const a: Account = {
        id,
        cash: RISK.startCash,
        peakEquity: RISK.startCash,
        dayKey: dayKey(),
        dayStartEquity: RISK.startCash,
        lossStreak: 0,
        cooldownUntil: 0,
        paused: null,
      };
      atomically(() => {
        // Exactly one opening credit per account; cash is always the sum of the account's ledger events.
        if (!hasOpening(id)) post({ account: id, type: "opening_capital", cashLamports: toLamports(RISK.startCash), payload: { startCash: RISK.startCash } });
        saveAccount(a);
      });
      accounts.set(id, a);
    }
  // Cash is a projection of the ledger.
  for (const a of accounts.values()) if (hasOpening(a.id)) a.cash = toSol(cashLamports(a.id));
  for (const id of IDS) initSleeves(id);
  // Orders survive restarts: buys past their timeout expire on the next tick, sells keep waiting for a price.
  orders.length = 0;
  for (const row of db.prepare("SELECT data FROM orders").all() as { data: string }[]) orders.push(JSON.parse(row.data) as Order);
  for (const row of db.prepare("SELECT data FROM positions").all() as { data: string }[]) {
    const p = JSON.parse(row.data) as Position;
    p.exiting = orders.some((o) => o.side === "sell" && o.positionId === p.id);
    positions.set(p.id, p);
  }
}

/** Mints with open positions stay deep-watched. */
export const heldMints = () => new Set([...positions.values()].map((p) => p.mint));
/** Mints the portfolio depends on: open positions and pending orders (never pruned, always recovered). */
export const obligationMints = () => new Set([...heldMints(), ...orders.map((o) => o.mint)]);

// ---------- equity & risk ----------

/** A mark older than this doesn't count as a reliable valuation. */
const VALUATION_MAX_AGE_MS = 60_000;

/** Quantity-specific net exit value now, or null when it can't be reliably valued (never zero by default). */
function positionValue(p: Position): number | null {
  const s = coins.get(p.mint);
  if (!s?.quote || Date.now() - s.quote.at > VALUATION_MAX_AGE_MS) return null;
  return liquidationValue(s, p.tokens);
}

/** Cash held back for this account's pending buys. */
export const reservedOf = (id: AccountId) => orders.filter((o) => o.account === id && o.side === "buy").reduce((t, o) => t + (o.reserveSol ?? 0), 0);
export const spendableOf = (id: AccountId) => accounts.get(id)!.cash - reservedOf(id);

// ---------- sleeves ----------

/** Accounts whose capital is partitioned by holding horizon (the strategy and its comparator, identically). */
const SLEEVED = new Set<AccountId>(["agent", "rules"]);
/**
 * Initial allocation (a configuration, not optimized weights): fast 60%, intraday 30%, 10% unallocated
 * reserve. Swing and position stay unfunded until their data contracts qualify; reallocation is an
 * explicit, zero-sum command.
 */
export const SLEEVE_PLAN: Record<SleeveId, number> = { fast: 0.6, intraday: 0.3, swing: 0, position: 0 };
export const SLEEVES: SleeveId[] = ["fast", "intraday", "swing", "position"];

const sleeveReserved = (id: AccountId, sleeve: SleeveId) =>
  orders.filter((o) => o.account === id && o.side === "buy" && (o.sleeve ?? "fast") === sleeve).reduce((t, o) => t + (o.reserveSol ?? 0), 0);
export function sleeveSpendable(id: AccountId, sleeve: SleeveId) {
  if (!SLEEVED.has(id)) return spendableOf(id);
  return toSol(sleeveCashLamports(id, sleeve)) - sleeveReserved(id, sleeve);
}
export function sleevesOf(id: AccountId) {
  if (!SLEEVED.has(id)) return null;
  const a = accounts.get(id)!;
  const rows = SLEEVES.map((sl) => ({ sleeve: sl, cashSol: toSol(sleeveCashLamports(id, sl)), reservedSol: sleeveReserved(id, sl) }));
  const allocated = rows.reduce((t, r) => t + r.cashSol, 0);
  return { sleeves: rows, unallocatedSol: a.cash - allocated };
}

/** First run with sleeves: allocate the plan from current cash (one time, journaled). */
function initSleeves(id: AccountId) {
  if (!SLEEVED.has(id) || hasAllocations(id)) return;
  ensureSleeveColumn();
  const cash = toLamports(accounts.get(id)!.cash);
  atomically(() => {
    for (const sl of SLEEVES) {
      const amt = Math.floor(cash * SLEEVE_PLAN[sl]);
      if (amt > 0) allocate(id, null, sl, amt, "initial sleeve plan");
    }
    journal("sleeve_allocation", null, { account: id, plan: SLEEVE_PLAN, cashSol: toSol(cash) });
  });
}

/** Moves unreserved cash between unallocated capital (null) and sleeves; never between accounts. */
export function reallocate(id: AccountId, from: SleeveId | null, to: SleeveId | null, amountSol: number): ControlResult {
  if (!SLEEVED.has(id)) return { status: "blocked", reasonCodes: ["account_not_sleeved"], detail: {} };
  if (from === to || !(amountSol > 0)) return { status: "blocked", reasonCodes: ["invalid_allocation"], detail: {} };
  const view = sleevesOf(id)!;
  const available = from === null ? view.unallocatedSol - (reservedOf(id) - SLEEVES.reduce((t, sl) => t + sleeveReserved(id, sl), 0)) : sleeveSpendable(id, from);
  if (available + 1e-12 < amountSol) return { status: "blocked", reasonCodes: ["insufficient_unreserved_cash"], detail: { availableSol: available } };
  atomically(() => {
    allocate(id, from, to, toLamports(amountSol), "operator reallocation");
    journal("sleeve_allocation", null, { account: id, from, to, amountSol });
  });
  return { status: "applied", reasonCodes: [], detail: { from, to, amountSol } };
}

/**
 * Account equity. When any position can't be reliably valued, `complete` is false and `equity` is only
 * the priced part: it is not a loss, and it never moves the risk anchors (peak, daily baseline).
 */
export function equityOf(id: AccountId) {
  const a = accounts.get(id)!;
  let value = 0;
  let unpriced = 0;
  for (const p of positions.values()) {
    if (p.account !== id) continue;
    const v = positionValue(p);
    if (v === null) unpriced++;
    else value += v;
  }
  return { cash: a.cash, reserved: reservedOf(id), positions: value, equity: a.cash + value, unpriced, complete: unpriced === 0 };
}

/** Updates the account's risk anchors from a reliable valuation; called on every tick, independent of signals. */
function updateRiskState(a: Account) {
  const { equity, complete } = equityOf(a.id);
  // Without a complete valuation the anchors stay as they are (a deferred day baseline keeps yesterday's guard).
  if (!complete) return;
  if (a.dayKey !== dayKey()) {
    a.dayKey = dayKey();
    a.dayStartEquity = equity;
    if (a.paused?.startsWith("Daily")) a.paused = null;
    saveAccount(a);
  }
  if (equity > a.peakEquity) {
    a.peakEquity = equity;
    saveAccount(a);
  }
}

/** Current drawdown from the reliably observed peak (0–1), or null without a complete valuation. */
export function drawdownOf(id: AccountId) {
  const a = accounts.get(id)!;
  const { equity, complete } = equityOf(id);
  return complete && a.peakEquity > 0 ? Math.max(0, 1 - equity / a.peakEquity) : null;
}

function riskGate(a: Account): string | null {
  const now = Date.now();
  updateRiskState(a);
  const { equity, complete, unpriced } = equityOf(a.id);
  if (a.paused) return a.paused;
  // Unknown valuation blocks new risk (exits continue); it is never treated as a loss.
  if (!complete) return `Valuation incomplete: ${unpriced} position${unpriced > 1 ? "s" : ""} without a reliable price`;
  if (equity <= a.peakEquity * (1 - RISK.maxDrawdown)) {
    a.paused = `Max drawdown ${(RISK.maxDrawdown * 100).toFixed(0)}% hit — paused until reset`;
    journal("risk_pause", null, { account: a.id, reason: a.paused, equity });
    saveAccount(a);
    return a.paused;
  }
  if (equity <= a.dayStartEquity * (1 - RISK.dailyLossLimit)) {
    a.paused = `Daily loss limit ${(RISK.dailyLossLimit * 100).toFixed(0)}% hit — paused until UTC midnight`;
    journal("risk_pause", null, { account: a.id, reason: a.paused, equity });
    saveAccount(a);
    return a.paused;
  }
  if (a.cooldownUntil > now) return `Cooling down after ${RISK.lossStreakCooldown.losses} losses in a row`;
  return null;
}

// ---------- calibration ----------

/**
 * What the shadow book has learned about a setup: trades, win rate, and average R after all costs,
 * shrunk toward zero while the sample is small. Only trades from strategy versions listed in
 * CONFIG.evidenceVersions count, so a rule change doesn't inherit evidence from different rules.
 */
export function setupEvidence(setup: SetupId, versions: string[] = CONFIG.evidenceVersions) {
  const rows = (db.prepare("SELECT data FROM closed WHERE account = 'shadow' AND setup = ?").all(setup) as { data: string }[])
    .map((r) => JSON.parse(r.data) as Closed)
    .filter((c) => c.version && versions.includes(c.version));
  const n = rows.length;
  const avgR = n ? rows.reduce((s, r) => s + r.r, 0) / n : 0;
  return {
    n,
    winRate: n ? rows.filter((r) => r.pnlSol > 0).length / n : 0,
    avgR,
    shrunkR: (avgR * n) / (n + RISK.priorWeight),
    versions,
  };
}

// ---------- entries ----------

const freshAnalysis = (s: CoinState, now = Date.now()) => (s.analysis && s.analysis.expiresAt > now ? s.analysis : null);

const uid = () => crypto.randomUUID();
const openFor = (account: AccountId, mint: string) => [...positions.values()].some((p) => p.account === account && p.mint === mint);
const pendingFor = (account: AccountId, mint: string) => orders.some((o) => o.account === account && o.mint === mint);

/**
 * Execution randomness is reproducible from the order id alone (independent of the statistics' random
 * stream, so viewing reports can never change a fill). Tests may inject a source.
 */
let drawSource = (orderId: string) => {
  const r = seededRandom(`exec:${orderId}`);
  return { latency: r(), fail: r() };
};
export const setDrawSource = (fn: typeof drawSource) => {
  drawSource = fn;
};

const EXEC_ASSUMPTIONS = () => ({ adverseSlippage: EXEC.adverseSlippage, networkFeeSol: NETWORK_FEE_SOL, maxImpact: RISK.maxImpact, stopGap: RISK.stopGap });

/** Places a paper buy, or records why it can't: no pool, no positive planned risk, or not enough spendable cash. */
function placeBuy(
  account: AccountId,
  s: CoinState,
  solIn: number,
  setup: SetupId | "random",
  plan: Plan,
  evidence: string[],
  reason: string,
  decision?: Decision,
): boolean {
  const now = Date.now();
  const reject = (code: string, detail: Record<string, unknown> = {}) => {
    journal("order_rejected", s.coin.mint, { account, setup, solIn, code, decisionId: decision?.id, ...detail });
    return false;
  };
  const pool = poolOf(s);
  if (!pool) return reject("no_executable_pool");
  // approved_plan_v2: freeze strictly positive planned risk for this exact size before submission.
  const r0Sol = -costModel(pool, plan, solIn, EXEC_ASSUMPTIONS()).stopNetSol;
  if (!(r0Sol > 0) || !(plan.stopSol < plan.entrySol)) return reject("non_positive_planned_risk", { r0Sol });
  const reserveSol = solIn + NETWORK_FEE_SOL;
  if (spendableOf(account) < reserveSol) return reject("insufficient_funds", { spendable: spendableOf(account), required: reserveSol });
  // A sleeve can't borrow another sleeve's idle cash.
  const sleeve: SleeveId = setup === "random" ? "fast" : (SETUP_SLEEVE[setup] ?? "fast");
  if (SLEEVED.has(account) && sleeveSpendable(account, sleeve) < reserveSol)
    return reject("sleeve_insufficient_funds", { sleeve, spendable: sleeveSpendable(account, sleeve), required: reserveSol });
  const id = uid();
  const draws = drawSource(id);
  const o: Order = {
    id,
    decisionId: decision?.id,
    analysisId: decision?.impact.analysisId,
    analystVerdict: decision?.analyst.verdict,
    account,
    mint: s.coin.mint,
    side: "buy",
    createdAt: now,
    notBefore: now + latency(draws.latency),
    decisionPriceSol: plan.entrySol,
    solIn,
    setup,
    plan,
    evidence,
    reason,
    version: CONFIG.strategyVersion,
    draws,
    reserveSol,
    r0Sol,
    sleeve: SLEEVED.has(account) ? sleeve : undefined,
    // The entry can't be submitted after its signal expires (each strategy declares its own TTL).
    submitBy: now + (plan.entryTtlMs ?? EXEC.orderTimeoutMs),
  };
  addOrder(o);
  journal("order", s.coin.mint, {
    id: o.id,
    decisionId: o.decisionId,
    analysisId: o.analysisId,
    account,
    side: "buy",
    solIn,
    setup,
    plan,
    reason,
    version: o.version,
    r0Sol,
    reserveSol,
    submitBy: o.submitBy,
  });
  return true;
}

export type Decision = { id: string; version: string } & DecisionResult;

const creatorOf = (mint: string) => coins.get(mint)?.coin.creator;
/** The analysis as recorded in a snapshot: everything the decision reads, without the bulky research bundle. */
const snapshotAnalysis = (a: Analysis | null): Analysis | null => (a ? { ...a, research: undefined } : null);

/** Everything the agent's decision depends on, frozen at decision time (replayable with decideFrom). */
export function buildSnapshot(s: CoinState, ev: SetupEval, now = Date.now(), accountId: "agent" | "rules" = "agent"): DecisionSnapshot {
  const a = accounts.get(accountId)!;
  const { equity } = equityOf(accountId);
  const agentPositions = [...positions.values()].filter((x) => x.account === accountId);
  const agentBuys = orders.filter((o) => o.account === accountId && o.side === "buy");
  const creator = s.coin.creator;
  const sameCreatorOpen =
    agentPositions.filter((p) => p.mint !== s.coin.mint && (p.creator ?? creatorOf(p.mint)) === creator).length +
    agentBuys.filter((o) => o.mint !== s.coin.mint && creatorOf(o.mint) === creator).length;
  const evd = setupEvidence(ev.setup);
  return {
    strategyVersion: CONFIG.strategyVersion,
    at: now,
    mint: s.coin.mint,
    symbol: s.coin.symbol,
    creator,
    setup: ev.setup,
    plan: ev.plan!,
    screens: s.screens.map((x) => ({ id: x.id, label: x.label, level: x.level, status: x.status })),
    essentials: essentialsFor(s, ev.setup, now),
    essentialsWithoutAnalysis: essentialsFor({ ...s, analysis: null }, ev.setup, now),
    evidence: evd,
    account: {
      equity,
      cash: sleeveSpendable(accountId, SETUP_SLEEVE[ev.setup] ?? "fast"),
      open: agentPositions.length + agentBuys.length,
      gate: riskGate(a),
      busy: openFor(accountId, s.coin.mint) || pendingFor(accountId, s.coin.mint),
      reentry: now - (lastExit.get(`${accountId}:${s.coin.mint}`) ?? 0) < RISK.reentryCooldownMs,
      sameCreatorOpen: sameCreatorOpen >= RISK.maxPerCreator ? sameCreatorOpen : 0,
    },
    regime: { level: regime.level, reasons: [...regime.reasons] },
    evidenceTimes: {
      quoteReceivedAt: s.quote?.at ?? null,
      lastTradeAt: s.trades.at(-1)?.ts ?? null,
      lastTradeReceivedAt: s.trades.at(-1)?.receivedAt ?? null,
      holdersAt: s.holders?.at ?? null,
      fundingAt: s.funding?.at ?? null,
      socialAt: s.social?.at ?? null,
      devAt: s.dev?.at ?? null,
      analysisAt: s.analysis?.at ?? null,
      tapeCoveredFrom: s.trades[0]?.ts ?? null,
    },
    analysis: snapshotAnalysis(s.analysis),
    pool: poolOf(s),
    exec: { adverseSlippage: EXEC.adverseSlippage, networkFeeSol: NETWORK_FEE_SOL, maxImpact: RISK.maxImpact, stopGap: RISK.stopGap },
    risk: {
      riskPerTrade: RISK.riskPerTrade,
      maxPositionFraction: RISK.maxPositionFraction,
      minOrderSol: RISK.minOrderSol,
      maxOpen: RISK.maxOpen,
      maxWarnings: RISK.maxWarnings,
      minEvidence: RISK.minEvidence,
      explorationRiskScale: RISK.explorationRiskScale,
      noAnalysisScale: RISK.noAnalysisScale,
      minEdgeR: RISK.minEdgeR,
      minNetRewardRisk: CONFIG.decision.minNetRewardRisk,
      sizingIterations: CONFIG.decision.sizingIterations,
    },
  };
}

/** The agent's judgment on a fired setup: a pure function of the recorded snapshot. */
export function decide(s: CoinState, ev: SetupEval): Decision & { snapshot: DecisionSnapshot } {
  const snapshot = buildSnapshot(s, ev);
  return { id: uid(), version: snapshot.strategyVersion, ...decideFrom(snapshot), snapshot };
}

/** Called each evaluation with a coin's fired setups. */
export function onSignals(s: CoinState, fired: SetupEval[]) {
  const now = Date.now();
  // Nothing can be priced or sized without a fresh quote (e.g. right after a restart): wait for one.
  if (!s.quote || now - s.quote.at > 10_000) return;
  for (const ev of fired) {
    if (!ev.plan) continue;
    const evidence = [...ev.structure, ...ev.trigger].filter((x) => x.ok).map((x) => `${x.label}: ${x.value}`);

    // Shadow: every fired setup, once per coin+setup per 10 minutes.
    const key = `${s.coin.mint}:${ev.setup}`;
    if (now - (lastShadow.get(key) ?? 0) > 10 * 60_000 && !openFor("shadow", s.coin.mint)) {
      lastShadow.set(key, now);
      placeBuy("shadow", s, RISK.fixedSizeSol, ev.setup, ev.plan, evidence, SETUP_LABEL[ev.setup]);
      journal("signal", s.coin.mint, {
        setup: ev.setup,
        plan: ev.plan,
        checks: [...ev.structure, ...ev.trigger],
        screens: s.screens,
        features: s.features,
      });
      openBaseline(s, ev.plan);
    }

    // Agent: its own judgment, re-asked at most once a minute per coin+setup.
    if (!openFor("agent", s.coin.mint) && !pendingFor("agent", s.coin.mint) && now - (lastDecision.get(key) ?? 0) > 60_000) {
      lastDecision.set(key, now);
      const { snapshot, ...d } = decide(s, ev);
      db.prepare("INSERT OR REPLACE INTO decisions (id, at, mint, version, snapshot, result) VALUES (?, ?, ?, ?, ?, ?)").run(
        d.id,
        snapshot.at,
        s.coin.mint,
        d.version,
        JSON.stringify(snapshot),
        JSON.stringify(d),
      );
      journal("decision", s.coin.mint, { setup: ev.setup, ...d, essentials: snapshot.essentials });
      recentDecisions.unshift({ at: now, mint: s.coin.mint, symbol: s.coin.symbol, setup: ev.setup, ...d, essentials: snapshot.essentials });
      recentDecisions.length = Math.min(recentDecisions.length, 100);
      // Comparator on the same opportunity: identical policy and snapshot, research removed.
      if (!openFor("rules", s.coin.mint) && !pendingFor("rules", s.coin.mint)) {
        const rs = { ...buildSnapshot(s, ev, now, "rules"), analysis: null, essentials: snapshot.essentialsWithoutAnalysis ?? snapshot.essentials };
        const r = { id: uid(), version: rs.strategyVersion, ...decideFrom(rs) };
        db.prepare("INSERT INTO comparator_decisions (id, opportunity_id, account, at, snapshot, result) VALUES (?, ?, 'rules', ?, ?, ?)").run(
          r.id,
          d.id,
          now,
          JSON.stringify(rs),
          JSON.stringify(r),
        );
        if (r.take) placeBuy("rules", s, r.sizeSol, ev.setup, ev.plan, evidence, `${SETUP_LABEL[ev.setup]} · rules only`, r);
      }
      if (d.take)
        placeBuy(
          "agent",
          s,
          d.sizeSol,
          ev.setup,
          ev.plan,
          evidence,
          `${SETUP_LABEL[ev.setup]} · ${d.mode === "explore" ? "exploring" : `edge ${(d.ev * 100).toFixed(1)}%`}`,
          d,
        );
    }
  }
}

export const recentDecisions: ({ at: number; mint: string; symbol: string; setup: SetupId; essentials?: DecisionSnapshot["essentials"] } & Decision)[] = [];

// ---------- follower experiment (wallet_follow_v1) ----------

/**
 * Registered follower policy, frozen before evaluation. It reacts to an observed buy by a tracked wallet
 * after that buy becomes available to us, with its own current quote, size and exits; the leader's fill
 * price is never inherited. These parameters are an experiment configuration, not calibrated values.
 */
export const FOLLOW_POLICY = {
  version: "wallet_follow_v1",
  minLeaderBuySol: 0.2,
  /** Ignore observations older than this (our reaction window after receipt). */
  maxSignalAgeMs: 10_000,
  /** Skip if the price already ran this far past the leader's fill. */
  maxDeterioration: 0.1,
  sizeSol: 0.1,
  stopPct: 0.15,
  tp1Pct: 0.3,
  tp2Pct: 0.6,
  maxHoldMin: 20,
};

const followed = new Map<string, number>(); // mint -> last follow decision time
/** Wallet trades observed on the tape: follow qualifying buys; a leader's sale closes only the follower's own lot. */
export function followerOnTrades(s: CoinState, fresh: Trade[], isTracked: (wallet: string) => boolean, now = Date.now()) {
  for (const t of fresh) {
    if (!isTracked(t.wallet)) continue;
    const received = t.receivedAt ?? now;
    if (t.side === "sell") {
      for (const p of positions.values())
        if (p.account === "follower" && p.mint === s.coin.mint && p.leader === t.wallet && !p.exiting) placeSell(p, 1, "Leader sold (observed)");
      continue;
    }
    if (t.sol < FOLLOW_POLICY.minLeaderBuySol || now - received > FOLLOW_POLICY.maxSignalAgeMs) continue;
    if (openFor("follower", s.coin.mint) || pendingFor("follower", s.coin.mint) || now - (followed.get(s.coin.mint) ?? 0) < 10 * 60_000) continue;
    if (!s.quote || now - s.quote.at > 10_000 || s.pulse?.status === "fail") continue;
    followed.set(s.coin.mint, now);
    const entry = s.quote.priceSol;
    if (entry > t.priceSol * (1 + FOLLOW_POLICY.maxDeterioration)) {
      journal("order_rejected", s.coin.mint, { account: "follower", code: "price_ran_past_leader", leaderPrice: t.priceSol, price: entry, leader: t.wallet });
      continue;
    }
    const plan: Plan = {
      entrySol: entry,
      stopSol: entry * (1 - FOLLOW_POLICY.stopPct),
      tp1Sol: entry * (1 + FOLLOW_POLICY.tp1Pct),
      tp2Sol: entry * (1 + FOLLOW_POLICY.tp2Pct),
      maxHoldMin: FOLLOW_POLICY.maxHoldMin,
      entryTtlMs: CONTRACTS.wallet_follow.entryTtlMs,
    };
    const ok = placeBuy("follower", s, FOLLOW_POLICY.sizeSol, "wallet_follow", plan, [`Leader ${t.wallet.slice(0, 4)}… bought ${t.sol.toFixed(2)}◎`, `Policy ${FOLLOW_POLICY.version}`], "Follow tracked wallet");
    if (ok) {
      const o = orders.at(-1)!;
      o.leader = t.wallet;
      saveOrder(o);
    }
  }
}

/** Control: same size, timing and plan shape as the shadow entry, on a random other hot coin. */
function openBaseline(trigger: CoinState, shape: Plan) {
  const now = Date.now();
  const candidates = [...coins.values()].filter(
    (s) =>
      s.hot && s !== trigger && s.quote && now - s.quote.at < 10_000 && !openFor("baseline", s.coin.mint) && !pendingFor("baseline", s.coin.mint),
  );
  if (!candidates.length) return;
  const s = candidates[Math.floor(Math.random() * candidates.length)];
  const entry = s.quote!.priceSol;
  const k = (v: number) => (v / shape.entrySol) * entry;
  const plan: Plan = { entrySol: entry, stopSol: k(shape.stopSol), tp1Sol: k(shape.tp1Sol), tp2Sol: k(shape.tp2Sol), maxHoldMin: shape.maxHoldMin };
  placeBuy("baseline", s, RISK.fixedSizeSol, "random", plan, ["Random control entry"], "Random control");
}

// ---------- order processing ----------

function closePosition(p: Position, reason: string) {
  const a = accounts.get(p.account)!;
  const fees = p.feesSol ?? 0;
  // Net PnL = sell credits − buy debit − fees of failed exit attempts (the same amounts the ledger posted).
  const pnl = p.proceedsSol - p.costSol - fees;
  // R uses the frozen, strictly positive R0 (approved_plan_v2). Legacy positions keep their original
  // definition, and a non-positive legacy denominator makes R unusable instead of flipping its sign.
  const legacyRisk = p.costSol * ((p.plan.entrySol - p.plan.stopSol) / p.plan.entrySol);
  const r0 = p.r0Sol && p.r0Sol > 0 ? p.r0Sol : legacyRisk;
  const rValid = r0 > 0;
  const c: Closed = {
    id: p.id,
    account: p.account,
    mint: p.mint,
    symbol: p.symbol,
    setup: p.setup,
    openedAt: p.openedAt,
    closedAt: Date.now(),
    costSol: p.costSol,
    proceedsSol: p.proceedsSol,
    pnlSol: pnl,
    pnlPct: p.costSol ? pnl / p.costSol : 0,
    r: rValid ? pnl / r0 : 0,
    exitReason: reason,
    holdMin: (Date.now() - p.openedAt) / 60_000,
    analystAtEntry: p.analystAtEntry ?? "none",
    entryAnalysisId: p.entryAnalysisId,
    entryDecisionId: p.entryDecisionId,
    exitAnalysisId: p.exitAnalysisId,
    version: p.version,
    r0Sol: rValid ? r0 : undefined,
    feesSol: fees,
    riskDefinitionVersion: p.r0Sol && p.r0Sol > 0 ? "approved_plan_v2" : "legacy_v1",
    rValid,
  };
  db.prepare("INSERT OR REPLACE INTO closed (id, account, setup, closed_at, data) VALUES (?, ?, ?, ?, ?)").run(
    c.id,
    c.account,
    c.setup,
    c.closedAt,
    JSON.stringify(c),
  );
  positions.delete(p.id);
  deletePosition(p.id);
  lastExit.set(`${p.account}:${p.mint}`, c.closedAt);
  a.lossStreak = pnl < 0 ? a.lossStreak + 1 : 0;
  if (a.lossStreak >= RISK.lossStreakCooldown.losses && p.account === "agent") a.cooldownUntil = Date.now() + RISK.lossStreakCooldown.ms;
  saveAccount(a);
  journal("close", p.mint, c);
}

const drawsOf = (o: Order) => o.draws ?? { latency: 0.5, fail: 1 };
/** Same freshness rule the fill model uses: a quote that arrived after the order's latency and is still current. */
const quoteReady = (s: CoinState, o: Order, now: number) => !!s.quote && s.quote.at >= o.notBefore && now - s.quote.at <= EXEC.quoteMaxAgeMs;

/** Ends an order that never reached submission: no fill, no fee, its reservation released. */
function endUnsubmitted(i: number, kind: "order_expired" | "order_cancelled", reason: string) {
  const o = orders[i];
  atomically(() => {
    removeOrder(i);
    journal(kind, o.mint, { orderId: o.id, decisionId: o.decisionId, account: o.account, side: o.side, reason });
  });
}

/**
 * Core execution profile "core_approximate_v1": a fill is modeled atomically at the first fresh quote after
 * the order's latency (zero in-flight interval). Everything before that point is pre-submission: deadline,
 * pause and structural invalidation are rechecked there and end the order with no fill and no fee.
 */
function processOrders() {
  const now = Date.now();
  for (let i = orders.length - 1; i >= 0; i--) {
    const o = orders[i];
    const s = coins.get(o.mint);
    const a = accounts.get(o.account)!;
    const expired = now - o.createdAt > EXEC.orderTimeoutMs;
    if (!s) {
      if (o.side === "sell") continue; // a held coin stays tracked; keep the exit until it can be priced
      endUnsubmitted(i, "order_expired", "Coin no longer tracked");
      continue;
    }
    if (o.side === "buy") {
      const submitBy = o.submitBy ?? o.createdAt + EXEC.orderTimeoutMs;
      if (now >= submitBy) {
        endUnsubmitted(i, "order_expired", quoteReady(s, o, now) ? "Signal deadline passed before submission" : "No fresh quote before the deadline");
        continue;
      }
      if (!quoteReady(s, o, now)) continue;
      // Final pre-submission checks against the quote the order would execute on.
      if (o.account === "agent" && a.paused) {
        endUnsubmitted(i, "order_cancelled", `Entries paused: ${a.paused}`);
        continue;
      }
      if (o.plan && s.quote!.priceSol <= o.plan.stopSol) {
        endUnsubmitted(i, "order_cancelled", "Structure invalidated before submission: price at or below the stop");
        continue;
      }
      const fill = fillBuy(s, o.solIn!, o.decisionPriceSol, o.notBefore, drawsOf(o).fail);
      if (fill === "wait") continue;
      if (!fill.ok) {
        atomically(() => {
          removeOrder(i);
          // A failed submitted attempt is an opportunity expense (no position exists).
          if (fill.feeSol > 0)
            a.cash = post({ account: o.account, type: "attempt_fee", cashLamports: -toLamports(fill.feeSol), mint: o.mint, orderId: o.id, decisionId: o.decisionId ?? null, sleeve: o.sleeve ?? null, payload: { side: "buy", reason: fill.reason } });
          saveAccount(a);
          journal("fill_failed", o.mint, { orderId: o.id, decisionId: o.decisionId, account: o.account, side: "buy", reason: fill.reason, feeSol: fill.feeSol });
        });
        continue;
      }
      const p: Position = {
        id: uid(),
        account: o.account,
        mint: o.mint,
        symbol: s.coin.symbol,
        setup: o.setup!,
        openedAt: now,
        entryPriceSol: fill.priceSol,
        tokens: fill.tokens,
        initialTokens: fill.tokens,
        costSol: fill.sol,
        proceedsSol: 0,
        // Re-anchor the plan to the actual fill so slippage doesn't silently widen the stop.
        plan: { ...o.plan!, entrySol: fill.priceSol },
        stopSol: o.plan!.stopSol,
        tp1Done: false,
        highSol: fill.priceSol,
        liquidityAtEntry: s.quote?.liquidityUsd || null,
        entryVetoes: s.screens.filter((x) => x.level === "veto").map((x) => x.id),
        analystAtEntry: o.account === "agent" ? (o.analystVerdict ?? "none") : (freshAnalysis(s)?.verdict ?? "none"),
        entryAnalysisId: o.analysisId,
        entryDecisionId: o.decisionId,
        evidence: o.evidence ?? [],
        exiting: false,
        creator: s.coin.creator,
        version: o.version,
        // The lot inherits the risk frozen before submission; later gaps never change it.
        r0Sol: o.r0Sol,
        riskDefinitionVersion: o.r0Sol ? "approved_plan_v2" : "legacy_v1",
        feesSol: 0,
        leader: o.leader,
        sleeveId: o.sleeve,
        managementSleeveId: o.sleeve,
      };
      atomically(() => {
        removeOrder(i);
        a.cash = post({ account: o.account, type: "buy_fill", cashLamports: -toLamports(fill.sol), mint: o.mint, orderId: o.id, positionId: p.id, decisionId: o.decisionId ?? null, sleeve: o.sleeve ?? null, payload: { tokens: fill.tokens, priceSol: fill.priceSol, impact: fill.impact } });
        saveAccount(a);
        positions.set(p.id, p);
        savePosition(p);
        journal("fill", o.mint, { orderId: o.id, decisionId: o.decisionId, analysisId: o.analysisId, positionId: p.id, account: o.account, side: "buy", sol: fill.sol, tokens: fill.tokens, priceSol: fill.priceSol, impact: fill.impact, r0Sol: o.r0Sol });
      });
    } else {
      const p = positions.get(o.positionId!);
      if (!p) {
        removeOrder(i);
        continue;
      }
      // Never sell more than the position still holds.
      const tokensIn = Math.min(o.tokensIn!, p.tokens);
      const fill = fillSell(s, tokensIn, o.notBefore, drawsOf(o).fail);
      if (fill === "wait") {
        // No fresh price: the position stays open (unpriced, not zero) and the exit keeps waiting. Nothing is invented.
        if (expired && !o.waitingSince) {
          o.waitingSince = now;
          saveOrder(o);
          journal("exit_waiting", o.mint, { orderId: o.id, positionId: p.id, account: o.account, reason: o.reason, lastQuoteAt: s.quote?.at ?? null });
        }
        continue;
      }
      if (!fill.ok) {
        atomically(() => {
          removeOrder(i);
          // A failed exit's fee belongs to the position's net PnL; inventory and TP state are unchanged.
          if (fill.feeSol > 0) {
            a.cash = post({ account: o.account, type: "attempt_fee", cashLamports: -toLamports(fill.feeSol), mint: o.mint, orderId: o.id, positionId: p.id, sleeve: p.sleeveId ?? null, payload: { side: "sell", reason: fill.reason, kind: o.kind ?? null } });
            p.feesSol = (p.feesSol ?? 0) + fill.feeSol;
          }
          p.exiting = false; // retry on the next tick
          saveAccount(a);
          savePosition(p);
          journal("fill_failed", o.mint, { orderId: o.id, decisionId: o.decisionId, account: o.account, side: "sell", reason: fill.reason, feeSol: fill.feeSol, positionId: p.id });
        });
        continue;
      }
      atomically(() => {
        removeOrder(i);
        a.cash = post({ account: o.account, type: "sell_fill", cashLamports: toLamports(fill.sol), mint: o.mint, orderId: o.id, positionId: p.id, sleeve: p.sleeveId ?? null, payload: { tokens: tokensIn, priceSol: fill.priceSol, reason: o.reason, kind: o.kind ?? null } });
        p.proceedsSol += fill.sol;
        p.tokens -= tokensIn;
        p.exiting = false;
        if (o.kind === "tp1") {
          // Only a confirmed TP1 fill locks in: stop to breakeven plus costs, then trail.
          p.tp1Done = true;
          p.stopSol = Math.max(p.stopSol, p.entryPriceSol * POST_TP1_STOP);
        }
        saveAccount(a);
        journal("fill", o.mint, { orderId: o.id, decisionId: o.decisionId, analysisId: o.analysisId, positionId: p.id, account: o.account, side: "sell", sol: fill.sol, tokens: tokensIn, priceSol: fill.priceSol, reason: o.reason });
        if (p.tokens <= p.initialTokens * 1e-6) {
          p.exitAnalysisId = o.analysisId;
          closePosition(p, o.reason);
        } else savePosition(p);
      });
    }
  }
}

function placeSell(
  p: Position,
  fraction: number,
  reason: string,
  analysisId: string | null = null,
  withoutExitReason: string | null = null,
  kind?: Order["kind"],
) {
  const now = Date.now();
  p.exiting = true;
  const decisionId = uid();
  const orderId = uid();
  const draws = drawSource(orderId);
  addOrder({
    id: orderId,
    decisionId,
    analysisId,
    account: p.account,
    mint: p.mint,
    side: "sell",
    createdAt: now,
    notBefore: now + latency(draws.latency),
    decisionPriceSol: p.entryPriceSol,
    tokensIn: fraction >= 0.999 ? p.tokens : p.tokens * fraction,
    positionId: p.id,
    reason,
    version: p.version,
    draws,
    kind,
  });
  journal("order", p.mint, { id: orderId, decisionId, analysisId, positionId: p.id, account: p.account, side: "sell", reason });
  if (analysisId) journal("exit_decision", p.mint, {
    id: decisionId, analysisId, orderId, positionId: p.id, account: p.account, reason,
    effect: withoutExitReason ? "exit_unchanged" : "exit_requested", withoutExitReason,
  });
}

// ---------- position management ----------

function manage(p: Position) {
  if (p.exiting) return;
  const s = coins.get(p.mint);
  if (!s?.quote) return;
  const price = s.quote.priceSol;
  const f = s.features;
  const heldMin = (Date.now() - p.openedAt) / 60_000;
  p.highSol = Math.max(p.highSol, price);

  if (price <= p.stopSol) return placeSell(p, 1, p.tp1Done ? "Trailing stop" : "Stop loss");
  // TP1 counts as done only when this sell fills (a failed sell is retried on the next tick).
  if (!p.tp1Done && price >= p.plan.tp1Sol) return placeSell(p, TP1_FRACTION, "Take profit 1 (half)", null, null, "tp1");
  if (p.tp1Done) {
    // Horizon lots trail on completed bars (lowest low of the last 3 minus the registered buffer);
    // fast lots trail a fixed fraction under the high. The stop never loosens.
    const tr = p.plan.trail;
    let trail = p.highSol * (1 - RISK.trailPct);
    if (tr) {
      const done = barsFor(s, tr.barMs, 5 * tr.barMs).filter((b) => b.state === "ok").slice(-3);
      trail = done.length === 3 ? Math.min(...done.map((b) => b.low)) - tr.buffer : p.stopSol;
    }
    if (trail > p.stopSol) {
      p.stopSol = trail;
      savePosition(p);
    }
  }
  if (price >= p.plan.tp2Sol) return placeSell(p, 1, "Take profit 2");
  if (heldMin >= p.plan.maxHoldMin) return placeSell(p, 1, "Time stop");

  // Thesis exits from live evidence.
  if (f && f.cohorts.dev.sellSol60s >= 0.2 && heldMin > 0.5) return placeSell(p, 1, "Dev is selling");
  const newVeto = s.screens.find((x) => x.level === "veto" && THESIS_VETOES.has(x.id) && !(p.entryVetoes ?? []).includes(x.id));
  if (newVeto) return placeSell(p, 1, `New veto: ${newVeto.label}`);
  const an = freshAnalysis(s);
  const liquidityPulled = p.liquidityAtEntry && s.quote.liquidityUsd && s.quote.liquidityUsd < p.liquidityAtEntry * 0.6;
  if (p.account === "agent" && an?.verdict === "reject" && an.at > p.openedAt)
    return placeSell(p, 1, "Analyst turned negative", analysisKey(p.mint, an), liquidityPulled ? "Liquidity pulled" : null);
  if (liquidityPulled) return placeSell(p, 1, "Liquidity pulled");
}

/** Screen vetoes that break a held position's thesis if they appear after entry. */
const THESIS_VETOES = new Set(["insiders", "bundles", "liquidity", "lp", "rugged", "metadata", "funding"]);

let lastEquityAt = 0;

export function portfolioTick() {
  processOrders();
  for (const p of [...positions.values()]) manage(p);
  // Risk anchors (peak, daily baseline) follow every reliable valuation, whether or not a signal arrives.
  for (const a of accounts.values()) updateRiskState(a);
  const now = Date.now();
  if (now - lastEquityAt >= 60_000) {
    lastEquityAt = now;
    for (const id of IDS) {
      const e = equityOf(id);
      // Only complete valuations enter the equity curve: an unpriced position is unknown, not zero.
      if (e.complete) db.prepare("INSERT OR REPLACE INTO equity (account, ts, equity) VALUES (?, ?, ?)").run(id, now, e.equity);
    }
  }
}

// ---------- reporting ----------

function statsOf(rows: Closed[]) {
  const n = rows.length;
  const wins = rows.filter((r) => r.pnlSol > 0);
  const pnl = rows.reduce((s, r) => s + r.pnlSol, 0);
  const cost = rows.reduce((s, r) => s + r.costSol, 0);
  const best = rows.reduce((m, r) => Math.max(m, r.pnlSol), 0);
  return {
    trades: n,
    winRate: n ? wins.length / n : 0,
    pnlSol: pnl,
    /** Return on capital deployed, after all costs. */
    returnOnCost: cost ? pnl / cost : 0,
    avgR: n ? rows.reduce((s, r) => s + r.r, 0) / n : 0,
    expectancySol: n ? pnl / n : 0,
    /** How much of the profit came from the single best trade. */
    bestShare: pnl > 0 ? best / pnl : null,
  };
}

/**
 * Research coverage (roadmap B9): of the agent's decisions under the current strategy version, how many
 * had a valid analyst report at decision time, and how old it was.
 */
export function researchCoverage(version = CONFIG.strategyVersion) {
  const rows = db
    .prepare(
      "SELECT at, json_extract(snapshot, '$.analysis.at') AS aAt, json_extract(snapshot, '$.analysis.expiresAt') AS aExp FROM decisions WHERE version = ?",
    )
    .all(version) as { at: number; aAt: number | null; aExp: number | null }[];
  const ages = rows.filter((r) => r.aAt != null && r.aExp != null && r.aExp > r.at).map((r) => (r.at - r.aAt!) / 60_000).sort((a, b) => a - b);
  return {
    version,
    decisions: rows.length,
    withValidReport: ages.length,
    share: rows.length ? ages.length / rows.length : 0,
    medianAgeMin: ages.length ? ages[ages.length >> 1] : null,
  };
}

export function portfolioReport() {
  const closed = (db.prepare("SELECT data FROM closed ORDER BY closed_at DESC").all() as { data: string }[]).map((r) => JSON.parse(r.data) as Closed);
  const accountsOut = IDS.map((id) => {
    const a = accounts.get(id)!;
    const rows = closed.filter((c) => c.account === id);
    const bySetup: Record<string, ReturnType<typeof statsOf>> = {};
    for (const setup of new Set(rows.map((r) => r.setup))) bySetup[setup] = statsOf(rows.filter((r) => r.setup === setup));
    // Does the analyst's verdict at entry predict outcomes? (Most meaningful on the shadow book.)
    const byAnalyst: Record<string, ReturnType<typeof statsOf>> = {};
    for (const v of new Set(rows.map((r) => r.analystAtEntry ?? "none")))
      byAnalyst[v] = statsOf(rows.filter((r) => (r.analystAtEntry ?? "none") === v));
    return {
      id,
      ...equityOf(id),
      sleeves: sleevesOf(id),
      startCash: RISK.startCash,
      paused: a.paused,
      cooldownUntil: a.cooldownUntil,
      lossStreak: a.lossStreak,
      stats: statsOf(rows),
      bySetup,
      byAnalyst,
      curve: (db.prepare("SELECT ts, equity FROM equity WHERE account = ? ORDER BY ts").all(id) as { ts: number; equity: number }[]).map((r) => [
        r.ts,
        r.equity,
      ]),
    };
  });
  const open = [...positions.values()].map((p) => {
    const v = positionValue(p);
    const s = coins.get(p.mint);
    return {
      ...p,
      priceSol: s?.quote?.priceSol ?? null,
      valueSol: v,
      unrealizedSol: v === null ? null : v + p.proceedsSol - p.costSol,
      heldMin: (Date.now() - p.openedAt) / 60_000,
    };
  });
  return {
    accounts: accountsOut,
    open,
    pending: orders.map((o) => ({ account: o.account, mint: o.mint, side: o.side, reason: o.reason, ageMs: Date.now() - o.createdAt, waiting: !!o.waitingSince })),
    closed: closed.slice(0, 100),
    decisions: recentDecisions.slice(0, 50),
    risk: RISK,
    strategyVersion: CONFIG.strategyVersion,
    evidenceVersions: CONFIG.evidenceVersions,
    researchCoverage: researchCoverage(),
  };
}

/** The agent wallet at a glance (header, dashboard). */
export function walletSummary() {
  const a = accounts.get("agent")!;
  const e = equityOf("agent");
  return {
    ...e,
    startCash: RISK.startCash,
    // With an incomplete valuation these are lower bounds over the priced part only (the UI labels them).
    pnlSol: e.equity - RISK.startCash,
    todayPnlSol: e.equity - a.dayStartEquity,
    drawdown: drawdownOf("agent"),
    peakEquity: a.peakEquity,
    open: [...positions.values()].filter((p) => p.account === "agent").length,
    paused: a.paused,
    cooldownUntil: a.cooldownUntil,
  };
}

// ---------- integrity ----------

/**
 * Checks the invariants the ledger must hold: cash equals the sum of ledger events (with exactly one
 * opening credit), pending buys never reserve more than cash, inventory is never negative, and every
 * ledger-backed position's recorded cost/proceeds/fees match its ledger events.
 */
export function reconciliationReport() {
  const issues: string[] = [];
  const accountsOut = IDS.map((id) => {
    const a = accounts.get(id)!;
    const ledger = cashLamports(id);
    const projected = toLamports(a.cash);
    if (!hasOpening(id)) issues.push(`${id}: no opening credit in the ledger`);
    if (Math.abs(ledger - projected) > 1) issues.push(`${id}: cash ${a.cash} differs from ledger ${toSol(ledger)}`);
    const reserved = reservedOf(id);
    if (reserved > a.cash + 1e-9) issues.push(`${id}: pending buys reserve ${reserved.toFixed(4)} but cash is ${a.cash.toFixed(4)}`);
    return { id, cashSol: a.cash, ledgerCashSol: toSol(ledger), reservedSol: reserved, spendableSol: a.cash - reserved };
  });
  for (const id of IDS) {
    const v = sleevesOf(id);
    if (!v) continue;
    for (const sl of v.sleeves) if (sl.cashSol < -1e-9) issues.push(`${id}/${sl.sleeve}: negative sleeve cash ${sl.cashSol}`);
    if (v.unallocatedSol < -1e-9) issues.push(`${id}: negative unallocated cash ${v.unallocatedSol}`);
  }
  for (const p of positions.values()) {
    if (p.tokens < 0) issues.push(`position ${p.id}: negative inventory`);
    const legNet = toSol(positionNetLamports(p.id));
    const hasLedgerBuy = !!db.prepare("SELECT 1 FROM ledger_events WHERE position_id = ? AND type = 'buy_fill'").get(p.id);
    if (hasLedgerBuy && Math.abs(legNet - (p.proceedsSol - p.costSol - (p.feesSol ?? 0))) > 2e-9)
      issues.push(`position ${p.id}: recorded cash flows differ from the ledger by ${(legNet - (p.proceedsSol - p.costSol - (p.feesSol ?? 0))).toExponential(2)} SOL`);
  }
  const dupes = db.prepare("SELECT order_id, type, COUNT(*) AS n FROM ledger_events WHERE order_id IS NOT NULL GROUP BY order_id, type HAVING n > 1").all();
  if (dupes.length) issues.push(`${dupes.length} orders with duplicate ledger outcomes`);
  return { ok: issues.length === 0, issues, accounts: accountsOut, openPositions: positions.size, pendingOrders: orders.length };
}

// ---------- operator controls (called through the idempotent command log) ----------

export type ControlResult = { status: "applied" | "blocked"; reasonCodes: string[]; detail: Record<string, unknown> };

/** Cancels the account's pending buys. In the core model every pending buy is still unsubmitted, so all are cancellable. */
export function cancelPendingBuys(id: AccountId = "agent", reason = "Cancelled by operator"): number {
  let n = 0;
  for (let i = orders.length - 1; i >= 0; i--)
    if (orders[i].account === id && orders[i].side === "buy") {
      endUnsubmitted(i, "order_cancelled", reason);
      n++;
    }
  return n;
}

/** Stops new entries and cancels unsubmitted buys; exits and position management continue. */
export function pauseEntries(reason = "Paused manually"): ControlResult {
  const a = accounts.get("agent")!;
  a.paused = reason;
  saveAccount(a);
  const cancelled = cancelPendingBuys("agent", `Entries paused: ${reason}`);
  journal("control", null, { action: "pause_entries", cancelled });
  return { status: "applied", reasonCodes: [], detail: { cancelledBuys: cancelled } };
}

/** What still blocks entries if the manual pause were lifted. */
function resumeBlockers(): string[] {
  const a = accounts.get("agent")!;
  const e = equityOf("agent");
  const out: string[] = [];
  if (!e.complete) out.push("valuation_incomplete");
  else {
    if (e.equity <= a.peakEquity * (1 - RISK.maxDrawdown)) out.push("max_drawdown_breached");
    if (a.dayKey === dayKey() && e.equity <= a.dayStartEquity * (1 - RISK.dailyLossLimit)) out.push("daily_loss_limit_breached");
  }
  return out;
}

/**
 * Lifts the pause only when the risk gates pass. Never resets history: the peak, the daily baseline,
 * the loss streak and cooldown all stay (resetting anchors is a separate, explicit command).
 */
export function resumeEntries(): ControlResult {
  const a = accounts.get("agent")!;
  const blockers = resumeBlockers();
  if (blockers.length) return { status: "blocked", reasonCodes: blockers, detail: { paused: a.paused } };
  a.paused = null;
  saveAccount(a);
  journal("control", null, { action: "resume_entries" });
  return { status: "applied", reasonCodes: [], detail: {} };
}

/** Explicit operator decision: restart the drawdown and daily-loss anchors from the current reliable equity. */
export function resetRiskAnchors(): ControlResult {
  const a = accounts.get("agent")!;
  const e = equityOf("agent");
  if (!e.complete) return { status: "blocked", reasonCodes: ["valuation_incomplete"], detail: {} };
  const before = { peakEquity: a.peakEquity, dayStartEquity: a.dayStartEquity, cooldownUntil: a.cooldownUntil };
  a.peakEquity = e.equity;
  a.dayStartEquity = e.equity;
  a.dayKey = dayKey();
  a.cooldownUntil = 0;
  a.lossStreak = 0;
  saveAccount(a);
  journal("control", null, { action: "reset_risk_anchors", before, equity: e.equity });
  return { status: "applied", reasonCodes: [], detail: { before, equity: e.equity } };
}

/** Requests a bounded exit for one position (no fill is assumed; it may wait for a price). */
export function requestExit(positionId: string, reason = "Exit requested by operator"): ControlResult {
  const p = positions.get(positionId);
  if (!p) return { status: "blocked", reasonCodes: ["position_not_found"], detail: {} };
  if (p.exiting) return { status: "blocked", reasonCodes: ["exit_already_pending"], detail: {} };
  placeSell(p, 1, reason);
  return { status: "applied", reasonCodes: [], detail: { positionId } };
}

/** Pauses entries and requests exits for every agent position. Positions that can't be priced stay visible. */
export function requestFlatten(): ControlResult {
  const paused = pauseEntries("Flatten requested");
  const requested: string[] = [];
  const pending: string[] = [];
  for (const p of positions.values()) {
    if (p.account !== "agent") continue;
    if (p.exiting) pending.push(p.id);
    else {
      placeSell(p, 1, "Flatten requested by operator");
      requested.push(p.id);
    }
  }
  return { status: "applied", reasonCodes: [], detail: { ...paused.detail, exitsRequested: requested, exitsAlreadyPending: pending } };
}

/** Back-compat for the old /api/control endpoint. */
export function control(action: "pause" | "resume") {
  return action === "pause" ? pauseEntries() : resumeEntries();
}
