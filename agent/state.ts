// In-memory market state: the coin universe, which coins are "hot" (deep-watched),
// and each hot coin's trade tape, holder and social reports.
import { CONFIG } from "./config";
import { db, journal, loadCoin, loadCoins, loadReport, loadTrades, saveCoin, saveReport, saveTrades } from "./db";
import { budget } from "./http";
import { wilsonLower } from "./stats";
import { devReport, dsQuotes, GT_URL, gtTrades, holderReport, pumpList, socialReport, tradePage } from "./sources";
import type { Analysis } from "./analyst";
import type { DevHistory, SetupEval } from "./setups";
import type { Coin, DevReport, Features, FundingReport, HolderReport, PairMarket, Quote, ScreenResult, SocialReport, Trade } from "./types";
import { evaluatePulse, type PulseEval } from "./pulse";

export type CoinState = {
  coin: Coin;
  hot: boolean;
  hotSince: number | null;
  score: number;
  trades: Trade[];
  ids: Set<string>;
  /** Tape reaches back to the coin's first trade. */
  fromLaunch: boolean;
  backfilling: boolean;
  /** Backfill attempted (once per hot stint). */
  backfilled: boolean;
  /** Polls whose page had no overlap with the tape we held (trades may be missing). */
  tapeGaps: number;
  /** When the live tape was last successfully polled (fast strategies require it to be recent). */
  lastPolledAt?: number;
  nextPollAt: number;
  holders: HolderReport | null;
  social: SocialReport | null;
  dev: DevReport | null;
  funding: FundingReport | null;
  quote: Quote | null;
  features: Features | null;
  screens: ScreenResult[];
  setups: SetupEval[];
  /** Latest analyst verdict (may be expired; check expiresAt). */
  analysis: Analysis | null;
  /** DexScreener activity for the Pulse filters (volume, txns, liquidity). */
  market?: PairMarket | null;
  /** This coin against its Pulse column's filters. */
  pulse?: PulseEval | null;
};

export const coins = new Map<string, CoinState>();
/** When we saw a tracked coin graduate (curve → PumpSwap), for the regime filter. Observed transitions only. */
export const graduations: number[] = [];
/** Mints that must stay deep-watched (open positions), set by the portfolio. */
export const pinned = new Set<string>();
/** Held or armed coins get their tapes polled first. */
const isPriority = (s: CoinState) => pinned.has(s.coin.mint) || s.setups.length > 0;
export const stats = { listRefreshes: 0, listErrors: 0, tapePolls: 0, tapeErrors: 0, tradesIngested: 0, startedAt: Date.now() };

function stateFor(coin: Coin): CoinState {
  let s = coins.get(coin.mint);
  if (!s) {
    s = {
      coin,
      hot: false,
      hotSince: null,
      score: 0,
      trades: [],
      ids: new Set(),
      fromLaunch: false,
      backfilling: false,
      backfilled: false,
      tapeGaps: 0,
      nextPollAt: 0,
      holders: loadReport<HolderReport>(coin.mint, "holders"),
      social: loadReport<SocialReport>(coin.mint, "social"),
      dev: loadReport<DevReport>(coin.mint, "dev"),
      funding: loadReport<FundingReport>(coin.mint, "funding"),
      quote: null,
      features: null,
      screens: [],
      setups: [],
      analysis: loadReport<Analysis>(coin.mint, "analysis"),
    };
    coins.set(coin.mint, s);
  } else {
    // Skip the first minutes after a restart: those transitions happened while we were down.
    if (s.coin.stage === "curve" && coin.stage === "migrated" && Date.now() - stats.startedAt > 120_000) graduations.push(Date.now());
    const migratedNow = s.coin.stage === "curve" && coin.stage === "migrated";
    s.coin = {
      ...coin,
      firstSeen: s.coin.firstSeen,
      // Keep what we learned about lifecycle; list data doesn't carry it.
      migratedAt: s.coin.migratedAt ?? coin.migratedAt ?? (migratedNow ? Date.now() : null),
      migratedAtSource: s.coin.migratedAtSource ?? coin.migratedAtSource ?? (migratedNow ? "observed" : null),
      launchObservedAt: s.coin.launchObservedAt ?? coin.launchObservedAt ?? null,
    };
  }
  return s;
}

/** A coin seen first on a real-time stream (merged with list data later; lifecycle facts are kept). */
export function ingestStreamCoin(coin: Coin): CoinState {
  const s = stateFor(coin);
  saveCoin(s.coin);
  return s;
}

/** Records a migration observed on a real-time stream (receipt time; the stream gives no event time). */
export function recordStreamMigration(mint: string, receivedAt: number, pool: string | null) {
  const s = coins.get(mint);
  if (!s) return false;
  if (s.coin.stage === "curve" && Date.now() - stats.startedAt > 120_000) graduations.push(receivedAt);
  s.coin = {
    ...s.coin,
    stage: "migrated",
    pool: pool ?? s.coin.pool,
    // A pool-creation time from the chain is better than our receipt time; keep it if we have it.
    migratedAt: s.coin.migratedAtSource === "pool_created" ? s.coin.migratedAt : receivedAt,
    migratedAtSource: s.coin.migratedAtSource === "pool_created" ? "pool_created" : "migration_stream",
  };
  saveCoin(s.coin);
  return true;
}

export function restore() {
  for (const c of loadCoins(Date.now() - CONFIG.universe.maxAgeMs)) stateFor(c);
}

/**
 * Restores coins the portfolio still depends on (open positions, pending orders) regardless of age or
 * discovery status, with their saved reports. Returns mints whose coin record couldn't be found.
 */
export function ensureCoins(mints: Iterable<string>): string[] {
  const missing: string[] = [];
  for (const mint of mints) {
    if (coins.has(mint)) continue;
    const c = loadCoin(mint);
    if (c) stateFor(c);
    else missing.push(mint);
  }
  return missing;
}

// ---------- universe ----------

export type Lane = "new" | "stretch" | "migrated";

/** Setuh's three discovery pools. Coins outside them aren't candidates. */
export function laneOf(c: Coin, now: number): Lane | null {
  const ageMin = (now - c.createdAt) / 60_000;
  if (c.stage === "migrated") return ageMin <= 6 * 60 ? "migrated" : null;
  if ((c.curveProgress ?? 0) >= 0.5) return ageMin <= 3 * 60 ? "stretch" : null;
  return ageMin <= 30 ? "new" : null;
}

/** Market-cap range (USD) each pool trades in; far outside it is noise or a fake price. */
const BANDS: Record<Lane, [number, number, number]> = {
  // [floor, sweet-spot ceiling, hard ceiling]
  new: [6_000, 40_000, 120_000],
  stretch: [12_000, 45_000, 120_000],
  migrated: [15_000, 500_000, 2_000_000],
};

/** Attention prior from list data alone (before we have a tape). */
function attention(c: Coin, now: number): number {
  const lane = laneOf(c, now);
  if (!lane) return -Infinity;
  const sinceTrade = (now - c.lastTradeAt) / 1000;
  if (sinceTrade > 180) return -Infinity;
  const [floor, sweet, ceiling] = BANDS[lane];
  if (c.mcapUsd > ceiling) return -Infinity;
  let s = 0;
  s += Math.max(0, 3 - sinceTrade / 30); // trading right now
  // Size helps (strongest predictor in research) up to the pool's sweet spot, then stops mattering.
  s += Math.log10(Math.max(1, Math.min(c.mcapUsd, sweet) / 1000)) * 2;
  if (c.mcapUsd < floor) s -= 4;
  // Social links are a weak, unproven signal (the Kamat collector-label result was retracted in its
  // revised version), so they only add a small, equal nudge; Pulse filters decide eligibility.
  s += 0.5 * [c.socials.telegram, c.socials.twitter, c.socials.website].filter(Boolean).length;
  s += Math.min(2, Math.log10(1 + c.replies));
  return s;
}

export async function refreshUniverse() {
  while (graduations.length && Date.now() - graduations[0] > 6 * 3600_000) graduations.shift();
  const lists = await Promise.all(
    [
      pumpList("created_timestamp"),
      pumpList("last_trade_timestamp"),
      pumpList("market_cap", "&complete=false"),
      // Migrated column: graduated coins that are trading now.
      pumpList("last_trade_timestamp", "&complete=true"),
    ].map((p) =>
      p.catch(() => {
        stats.listErrors++;
        return [] as Coin[];
      }),
    ),
  );
  stats.listRefreshes++;
  const now = Date.now();
  for (const c of lists.flat()) {
    const s = stateFor(c);
    saveCoin(s.coin);
  }
  for (const [mint, s] of coins) {
    if (now - s.coin.createdAt > CONFIG.universe.maxAgeMs && !s.hot && !pinned.has(mint)) coins.delete(mint);
    else {
      s.score = attention(s.coin, now);
      evaluatePulse(s, now);
    }
  }
  selectHot(now);
}

function selectHot(now: number) {
  const all = [...coins.values()];
  // Pulse decides eligibility: a coin its column's filters reject never takes a deep-watch slot, and a
  // held slot is released as soon as the coin fails (e.g. snipers turn out high once the tape loads).
  const eligible = (s: CoinState) => s.pulse && s.pulse.status !== "fail";
  // Keep recently promoted coins that are still trading, still in a pool and still eligible.
  const keep = all.filter(
    (s) =>
      pinned.has(s.coin.mint) ||
      (s.hot &&
        eligible(s) &&
        laneOf(s.coin, now) &&
        now - (s.hotSince ?? 0) < CONFIG.universe.minHotMs &&
        now - lastActivity(s) < CONFIG.universe.idleMs),
  );
  const hot = new Set(keep);
  // Coins that pass every filter first, then those still being checked; attention breaks ties.
  const rank = (s: CoinState) => (s.pulse?.status === "pass" ? 100 : 0) + liveScore(s);
  const ranked = all.filter((s) => !hot.has(s) && eligible(s) && s.score > -Infinity).sort((a, b) => rank(b) - rank(a));
  // Fill each pool's share of slots first, then any leftover slots with the best of the rest.
  for (const [lane, slots] of Object.entries(CONFIG.universe.laneSlots) as [Lane, number][]) {
    let have = [...hot].filter((s) => laneOf(s.coin, now) === lane).length;
    for (const s of ranked) {
      if (have >= slots) break;
      if (!hot.has(s) && laneOf(s.coin, now) === lane) {
        hot.add(s);
        have++;
      }
    }
  }
  for (const s of ranked) {
    if (hot.size >= CONFIG.universe.hotSlots) break;
    hot.add(s);
  }
  for (const s of all) {
    const want = hot.has(s);
    if (want && !s.hot) {
      s.hot = true;
      s.hotSince = now;
      s.nextPollAt = 0;
      if (!s.trades.length) for (const t of loadTrades(s.coin.mint)) addTrade(s, t);
      journal("hot", s.coin.mint, { symbol: s.coin.symbol, score: s.score });
    } else if (!want && s.hot) {
      s.hot = false;
      s.hotSince = null;
      // Free memory; the tape stays in SQLite.
      s.trades = [];
      s.ids.clear();
      s.fromLaunch = false;
      s.backfilled = false;
      s.tapeGaps = 0;
    }
  }
}

function lastActivity(s: CoinState) {
  return Math.max(s.coin.lastTradeAt, s.trades.at(-1)?.ts ?? 0);
}

/** Once we have a tape, real order flow outranks the list prior. */
function liveScore(s: CoinState) {
  const f = s.features;
  if (!f) return s.score;
  return s.score + Math.min(4, f.flow5m.buyers / 15) + (f.flow60s.netSol > 0 ? 1 : 0);
}

// ---------- tape ----------

db.exec(`
  CREATE TABLE IF NOT EXISTS coverage_intervals (
    mint TEXT NOT NULL,
    kind TEXT NOT NULL,
    covered_from INTEGER,
    covered_to INTEGER,
    from_launch INTEGER NOT NULL,
    gaps INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (mint, kind)
  ) WITHOUT ROWID;
`);
const upsertCoverage = db.prepare(
  "INSERT OR REPLACE INTO coverage_intervals (mint, kind, covered_from, covered_to, from_launch, gaps, updated_at) VALUES (?, 'tape', ?, ?, ?, ?, ?)",
);
/**
 * The trade tape we hold for a coin: from the first to the last trade, whether it reaches launch, and how
 * many polls may have missed trades. A gap is never closed by a later page without verified overlap.
 */
export function tapeCoverage(s: CoinState) {
  return { coveredFrom: s.trades[0]?.ts ?? null, coveredTo: s.trades.at(-1)?.ts ?? null, fromLaunch: s.fromLaunch, gaps: s.tapeGaps };
}
const saveCoverage = (s: CoinState) => {
  const c = tapeCoverage(s);
  upsertCoverage.run(s.coin.mint, c.coveredFrom, c.coveredTo, c.fromLaunch ? 1 : 0, c.gaps, Date.now());
};

/** Called with each batch of newly seen trades (e.g. watched-trader alerts). */
export const tradeListeners: ((s: CoinState, fresh: Trade[]) => void)[] = [];
const notifyTrades = (s: CoinState, fresh: Trade[]) => {
  if (fresh.length) for (const l of tradeListeners) l(s, fresh);
};

function addTrade(s: CoinState, t: Trade): boolean {
  if (s.ids.has(t.tx)) return false;
  s.ids.add(t.tx);
  // Trades mostly arrive in order; insert from the end.
  let i = s.trades.length;
  while (i > 0 && s.trades[i - 1].id > t.id) i--;
  s.trades.splice(i, 0, t);
  return true;
}

async function backfill(s: CoinState) {
  s.backfilling = true;
  try {
    let cursor: string | null = null;
    for (let pages = 0; ; pages++) {
      const page = await tradePage(s.coin.mint, cursor);
      const receivedAt = Date.now();
      const fresh = page.trades.map((t) => ({ ...t, receivedAt })).filter((t) => addTrade(s, t));
      saveTrades(fresh);
      notifyTrades(s, fresh);
      stats.tradesIngested += fresh.length;
      if (!page.hasMore || !page.nextCursor) {
        s.fromLaunch = true;
        break;
      }
      if (pages + 1 >= CONFIG.tape.maxBackfillPages) break;
      cursor = page.nextCursor;
    }
  } finally {
    s.backfilling = false;
  }
}

/** Launch cohorts matter most for New coins; older coins lean on holder reports instead. */
const wantsBackfill = (s: CoinState) => !s.backfilled && s.coin.stage === "curve" && Date.now() - s.coin.createdAt < 30 * 60_000;

/** Live tape poll: GeckoTerminal's last 300 trades (its own rate limit, deeper than pump.fun's 100). */
async function pollTape(s: CoinState) {
  stats.tapePolls++;
  const receivedAt = Date.now();
  // Held positions' tapes are protective work and jump the queue.
  const page = (await gtTrades(s.coin.mint, pairAddress(s.coin), pinned.has(s.coin.mint) ? 0 : 1)).map((t) => ({ ...t, receivedAt }));
  // A full page that shares nothing with what we hold means trades in between were missed.
  if (s.trades.length && page.length >= 250 && !page.some((t) => s.ids.has(t.tx))) s.tapeGaps++;
  const fresh = page.filter((t) => addTrade(s, t));
  saveTrades(fresh);
  notifyTrades(s, fresh);
  s.lastPolledAt = receivedAt;
  saveCoverage(s);
  stats.tradesIngested += fresh.length;
  const last = s.trades.at(-1);
  if (last) s.coin.lastTradeAt = Math.max(s.coin.lastTradeAt, last.ts);
}

/** How long until a 100-trade page could start missing this coin's trades (with margin). */
function pollInterval(s: CoinState, now: number) {
  const recent = s.trades.filter((t) => t.ts >= now - 120_000).length;
  const perMs = recent / 120_000;
  // Pages hold 100 (pump.fun) to 300 (GeckoTerminal) trades; plan for the smaller one.
  const fill = perMs > 0 ? (CONFIG.tape.pageSize * 0.6) / perMs : Infinity;
  // Held and armed coins need fresh order flow for triggers and thesis exits.
  const cap = isPriority(s) ? CONFIG.tape.priorityPollMs : CONFIG.tape.maxPollMs;
  return Math.max(CONFIG.tape.minPollMs, Math.min(cap, fill));
}

/** Poll the most overdue hot coins that the request budget allows. */
export async function tapeTick(onUpdate: (s: CoinState) => void) {
  const now = Date.now();
  const due = [...coins.values()]
    .filter((s) => s.hot && !s.backfilling && s.nextPollAt <= now)
    .sort((a, b) => Number(isPriority(b)) - Number(isPriority(a)) || a.nextPollAt - b.nextPollAt);
  // Live polls ride on GeckoTerminal; pump.fun's tight budget is kept for launch backfills,
  // which run in the background so a slow backfill never stalls everyone else's polls.
  const backfilling = [...coins.values()].filter((s) => s.backfilling).length;
  for (const s of [...coins.values()].filter((s) => s.hot && wantsBackfill(s)).slice(0, Math.max(0, 2 - backfilling))) {
    s.backfilled = true;
    backfill(s)
      .then(() => onUpdate(s))
      .catch(() => stats.tapeErrors++);
  }
  const polls = due.slice(0, Math.max(0, budget(GT_URL)));
  await Promise.all(
    polls.map(async (s) => {
      s.nextPollAt = now + pollInterval(s, now);
      try {
        await pollTape(s);
        onUpdate(s);
      } catch {
        stats.tapeErrors++;
        s.nextPollAt = Date.now() + 10_000;
      }
    }),
  );
}

// ---------- holders & socials ----------

// Last attempt per mint, so a failing source isn't retried every tick.
const holdersTried = new Map<string, number>();
const socialTried = new Map<string, number>();
const devTried = new Map<string, number>();

export async function reportsTick() {
  const now = Date.now();
  const hot = [...coins.values()].filter((s) => s.hot);
  const due = (tried: Map<string, number>, at: number | undefined, every: number, mint: string) =>
    (!at || now - at > every) && now - (tried.get(mint) ?? 0) > Math.min(every, 60_000);
  const holderDue = hot.filter((s) => due(holdersTried, s.holders?.at, CONFIG.holders.refreshMs, s.coin.mint)).slice(0, 3);
  const socialDue = hot.filter((s) => due(socialTried, s.social?.at, CONFIG.socials.refreshMs, s.coin.mint)).slice(0, 3);
  for (const s of holderDue) holdersTried.set(s.coin.mint, now);
  for (const s of socialDue) socialTried.set(s.coin.mint, now);
  // Creator history changes slowly; one lookup per coin per 30 minutes.
  const devDue = hot.filter((s) => s.coin.creator && due(devTried, s.dev?.at, 30 * 60_000, s.coin.mint)).slice(0, 2);
  for (const s of devDue) devTried.set(s.coin.mint, now);
  await Promise.all([
    ...holderDue.map(async (s) => {
      try {
        s.holders = await holderReport(s.coin);
        saveReport(s.coin.mint, "holders", s.holders.at, s.holders);
      } catch {
        // Leave the old report; screens show it as stale/unknown.
      }
    }),
    ...devDue.map(async (s) => {
      try {
        s.dev = await devReport(s.coin);
        saveReport(s.coin.mint, "dev", s.dev.at, s.dev);
      } catch {
        // Unavailable: screens show developer history as unknown.
      }
    }),
    ...socialDue.map(async (s) => {
      s.social = await socialReport(s.coin);
      saveReport(s.coin.mint, "social", s.social.at, s.social);
    }),
  ]);
}

/** The pair DexScreener knows this coin by: the curve while bonding, the PumpSwap pool after. */
export const pairAddress = (c: Coin) => (c.stage === "migrated" && c.pool ? c.pool : c.curve);

/** Fast lane: price + liquidity for every hot coin in one DexScreener call. */
export async function quoteTick() {
  const hot = [...coins.values()].filter((s) => s.hot);
  if (!hot.length) return;
  const quotes = await dsQuotes(hot.map((s) => pairAddress(s.coin)));
  for (const s of hot) {
    const q = quotes[pairAddress(s.coin)];
    if (!q) continue;
    s.quote = q;
    // A PumpSwap pool is created at migration: its creation time is the migration time.
    if (s.coin.stage === "migrated" && q.pairCreatedAt && s.coin.migratedAtSource !== "pool_created") {
      s.coin.migratedAt = q.pairCreatedAt;
      s.coin.migratedAtSource = "pool_created";
    }
  }
}

// ---------- creator history ----------

/**
 * Prior launches by this coin's creator: pump.fun's record when we have it, else coins we've observed.
 * Only launches before this one, and only resolved ones (old enough to know the outcome), count.
 */
export function devHistory(s: CoinState): DevHistory {
  const proven = (successes: number, resolved: number, lowerBound: number) =>
    resolved >= CONFIG.developer.minResolved && lowerBound >= CONFIG.developer.minSuccessLowerBound;
  if (s.dev && s.dev.resolved !== undefined) {
    const d = s.dev;
    return { coins: d.launches, resolved: d.resolved, successes: d.successes, successRate: d.successRate, lowerBound: d.successLowerBound, proven: proven(d.successes, d.resolved, d.successLowerBound), source: "pump.fun" };
  }
  const rows = db.prepare("SELECT data FROM coins WHERE json_extract(data, '$.creator') = ?").all(s.coin.creator) as { data: string }[];
  const now = Date.now();
  const prior = rows.map((r) => JSON.parse(r.data) as Coin).filter((c) => c.mint !== s.coin.mint && c.createdAt < s.coin.createdAt);
  const resolved = prior.filter((c) => now - c.createdAt >= CONFIG.developer.resolveAfterMs);
  const successes = resolved.filter((c) => c.stage === "migrated" || (c.athMcapUsd ?? 0) >= 100_000).length;
  const lowerBound = wilsonLower(successes, resolved.length);
  return {
    coins: prior.length,
    resolved: resolved.length,
    successes,
    successRate: resolved.length ? successes / resolved.length : 0,
    lowerBound,
    proven: proven(successes, resolved.length, lowerBound),
    source: "observed",
  };
}
