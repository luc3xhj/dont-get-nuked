// Paper accounts, decisions, orders, position management and risk.
//   agent    — the strategy: screens + EV after costs + risk sizing + portfolio limits
//   shadow   — takes EVERY setup that fires at a fixed size: measures each setup's raw edge
//   baseline — whenever shadow enters, enters a RANDOM other hot coin with the same plan shape:
//              if setups can't beat this, we have no edge
import { NETWORK_FEE_SOL } from "../src/lib/amm";
import { CONFIG } from "./config";
import { db, journal } from "./db";
import { decideFrom, POST_TP1_STOP, TP1_FRACTION, type DecisionResult, type DecisionSnapshot } from "./decision";
import { EXEC, fillBuy, fillSell, latency, liquidationValue, poolOf } from "./execution";
import { essentialsFor } from "./requirements";
import { SETUP_LABEL, type Plan, type SetupEval, type SetupId } from "./setups";
import type { Analysis } from "./analyst";
import { regime } from "./regime";
import { coins, type CoinState } from "./state";
import { analysisKey } from "./analysis-impact";

export type AccountId = "agent" | "shadow" | "baseline";

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
`);

const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const IDS: AccountId[] = ["agent", "shadow", "baseline"];

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
      accounts.set(id, a);
      saveAccount(a);
    }
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

// ---------- equity & risk ----------

function positionValue(p: Position): number | null {
  const s = coins.get(p.mint);
  return s ? liquidationValue(s, p.tokens) : null;
}

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
  return { cash: a.cash, positions: value, equity: a.cash + value, unpriced };
}

function riskGate(a: Account): string | null {
  const now = Date.now();
  const { equity } = equityOf(a.id);
  if (a.dayKey !== dayKey()) {
    a.dayKey = dayKey();
    a.dayStartEquity = equity;
    if (a.paused?.startsWith("Daily")) a.paused = null;
    saveAccount(a);
  }
  a.peakEquity = Math.max(a.peakEquity, equity);
  if (a.paused) return a.paused;
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

const newDraws = () => ({ latency: Math.random(), fail: Math.random() });

function placeBuy(account: AccountId, s: CoinState, solIn: number, setup: SetupId | "random", plan: Plan, evidence: string[], reason: string, decision?: Decision) {
  const now = Date.now();
  const draws = newDraws();
  const o: Order = {
    id: uid(),
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
  };
  addOrder(o);
  journal("order", s.coin.mint, { id: o.id, decisionId: o.decisionId, analysisId: o.analysisId, account, side: "buy", solIn, setup, plan, reason, version: o.version });
}

export type Decision = { id: string; version: string } & DecisionResult;

const creatorOf = (mint: string) => coins.get(mint)?.coin.creator;
/** The analysis as recorded in a snapshot: everything the decision reads, without the bulky research bundle. */
const snapshotAnalysis = (a: Analysis | null): Analysis | null => (a ? { ...a, research: undefined } : null);

/** Everything the agent's decision depends on, frozen at decision time (replayable with decideFrom). */
export function buildSnapshot(s: CoinState, ev: SetupEval, now = Date.now()): DecisionSnapshot {
  const a = accounts.get("agent")!;
  const { equity } = equityOf("agent");
  const agentPositions = [...positions.values()].filter((x) => x.account === "agent");
  const agentBuys = orders.filter((o) => o.account === "agent" && o.side === "buy");
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
      cash: a.cash,
      open: agentPositions.length + agentBuys.length,
      gate: riskGate(a),
      busy: openFor("agent", s.coin.mint) || pendingFor("agent", s.coin.mint),
      reentry: now - (lastExit.get(`agent:${s.coin.mint}`) ?? 0) < RISK.reentryCooldownMs,
      sameCreatorOpen: sameCreatorOpen >= RISK.maxPerCreator ? sameCreatorOpen : 0,
    },
    regime: { level: regime.level, reasons: [...regime.reasons] },
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
  const pnl = p.proceedsSol - p.costSol;
  const riskSol = p.costSol * ((p.plan.entrySol - p.plan.stopSol) / p.plan.entrySol);
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
    r: riskSol ? pnl / riskSol : 0,
    exitReason: reason,
    holdMin: (Date.now() - p.openedAt) / 60_000,
    analystAtEntry: p.analystAtEntry ?? "none",
    entryAnalysisId: p.entryAnalysisId,
    entryDecisionId: p.entryDecisionId,
    exitAnalysisId: p.exitAnalysisId,
    version: p.version,
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

function processOrders() {
  const now = Date.now();
  for (let i = orders.length - 1; i >= 0; i--) {
    const o = orders[i];
    const s = coins.get(o.mint);
    const a = accounts.get(o.account)!;
    const expired = now - o.createdAt > EXEC.orderTimeoutMs;
    if (!s) {
      if (o.side === "sell") continue; // a held coin stays tracked; keep the exit until it can be priced
      atomically(() => {
        removeOrder(i);
        journal("order_expired", o.mint, { orderId: o.id, decisionId: o.decisionId, account: o.account, side: o.side, reason: "Coin no longer tracked" });
      });
      continue;
    }
    if (o.side === "buy") {
      const fill = fillBuy(s, o.solIn!, o.decisionPriceSol, o.notBefore, drawsOf(o).fail);
      if (fill === "wait") {
        if (expired)
          atomically(() => {
            removeOrder(i);
            journal("order_expired", o.mint, { orderId: o.id, decisionId: o.decisionId, account: o.account, side: "buy" });
          });
        continue;
      }
      if (!fill.ok) {
        atomically(() => {
          removeOrder(i);
          a.cash -= fill.feeSol;
          saveAccount(a);
          journal("fill_failed", o.mint, { orderId: o.id, decisionId: o.decisionId, account: o.account, side: "buy", reason: fill.reason });
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
      };
      atomically(() => {
        removeOrder(i);
        a.cash -= fill.sol;
        saveAccount(a);
        positions.set(p.id, p);
        savePosition(p);
        journal("fill", o.mint, { orderId: o.id, decisionId: o.decisionId, analysisId: o.analysisId, positionId: p.id, account: o.account, side: "buy", sol: fill.sol, tokens: fill.tokens, priceSol: fill.priceSol, impact: fill.impact });
      });
    } else {
      const p = positions.get(o.positionId!);
      if (!p) {
        removeOrder(i);
        continue;
      }
      const tokensIn = Math.min(o.tokensIn!, p.tokens);
      const fill = fillSell(s, tokensIn, o.notBefore, drawsOf(o).fail);
      if (fill === "wait") {
        // No fresh price: the position stays open (valued at zero) and the exit keeps waiting. Nothing is invented.
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
          a.cash -= fill.feeSol;
          p.exiting = false; // retry on the next tick
          saveAccount(a);
          journal("fill_failed", o.mint, { orderId: o.id, decisionId: o.decisionId, account: o.account, side: "sell", reason: fill.reason });
        });
        continue;
      }
      atomically(() => {
        removeOrder(i);
        a.cash += fill.sol;
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
  const draws = newDraws();
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
    const trail = p.highSol * (1 - RISK.trailPct);
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
  const now = Date.now();
  if (now - lastEquityAt >= 60_000) {
    lastEquityAt = now;
    for (const id of IDS) {
      const e = equityOf(id);
      if (e.unpriced === 0 || id !== "agent")
        db.prepare("INSERT OR REPLACE INTO equity (account, ts, equity) VALUES (?, ?, ?)").run(id, now, e.equity);
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
    pnlSol: e.equity - RISK.startCash,
    todayPnlSol: e.equity - a.dayStartEquity,
    open: [...positions.values()].filter((p) => p.account === "agent").length,
    paused: a.paused,
    cooldownUntil: a.cooldownUntil,
  };
}

export function control(action: "pause" | "resume") {
  const a = accounts.get("agent")!;
  if (action === "pause") a.paused = "Paused manually";
  if (action === "resume") {
    a.paused = null;
    a.cooldownUntil = 0;
    a.peakEquity = equityOf("agent").equity;
    a.dayStartEquity = a.peakEquity;
  }
  saveAccount(a);
  journal("control", null, { action });
}
