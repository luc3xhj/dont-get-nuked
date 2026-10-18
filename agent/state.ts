// In-memory market state: the coin universe, which coins are "hot" (deep-watched),
// and each hot coin's trade tape, holder and social reports.
import { CONFIG } from "./config";
import { db, journal, loadCoins, loadReport, loadTrades, saveCoin, saveReport, saveTrades } from "./db";
import { budget } from "./http";
import { devReport, dsQuotes, GT_URL, gtTrades, holderReport, pumpList, socialReport, tradePage } from "./sources";
import type { Analysis } from "./analyst";
import type { SetupEval } from "./setups";
import type { Coin, DevReport, Features, FundingReport, HolderReport, Quote, ScreenResult, SocialReport, Trade } from "./types";

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
    s.coin = { ...coin, firstSeen: s.coin.firstSeen };
  }
  return s;
}

export function restore() {
  for (const c of loadCoins(Date.now() - CONFIG.universe.maxAgeMs)) stateFor(c);
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
  if (c.socials.telegram) s += 2; // ~9x graduation lift in Kamat 2026
  if (c.socials.twitter) s += 1;
  if (c.socials.website) s += 0.5;
  s += Math.min(2, Math.log10(1 + c.replies));
  return s;
}

export async function refreshUniverse() {
  while (graduations.length && Date.now() - graduations[0] > 6 * 3600_000) graduations.shift();
  const lists = await Promise.all(
    [pumpList("created_timestamp"), pumpList("last_trade_timestamp"), pumpList("market_cap", "&complete=false")].map((p) =>
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
    else s.score = attention(s.coin, now);
  }
  selectHot(now);
}

function selectHot(now: number) {
  const all = [...coins.values()];
  // Keep recently promoted coins that are still trading and still in a pool.
  const keep = all.filter(
    (s) =>
      pinned.has(s.coin.mint) ||
      (s.hot && laneOf(s.coin, now) && now - (s.hotSince ?? 0) < CONFIG.universe.minHotMs && now - lastActivity(s) < CONFIG.universe.idleMs),
  );
  const hot = new Set(keep);
  const ranked = all.filter((s) => !hot.has(s) && s.score > -Infinity).sort((a, b) => liveScore(b) - liveScore(a));
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
      const fresh = page.trades.filter((t) => addTrade(s, t));
      saveTrades(fresh);
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
  const fresh = (await gtTrades(s.coin.mint, pairAddress(s.coin))).filter((t) => addTrade(s, t));
  saveTrades(fresh);
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
    if (q) s.quote = q;
  }
}

// ---------- creator history ----------

/** Prior launches by this coin's creator: pump.fun's record when we have it, else coins we've observed. */
export function devHistory(s: CoinState) {
  if (s.dev) return { coins: s.dev.launches, successes: s.dev.successes, successRate: s.dev.successRate, source: "pump.fun" as const };
  const rows = db.prepare("SELECT data FROM coins WHERE json_extract(data, '$.creator') = ?").all(s.coin.creator) as { data: string }[];
  const prior = rows.map((r) => JSON.parse(r.data) as Coin).filter((c) => c.mint !== s.coin.mint);
  const successes = prior.filter((c) => c.stage === "migrated" || (c.athMcapUsd ?? 0) >= 100_000).length;
  return { coins: prior.length, successes, successRate: prior.length ? successes / prior.length : 0, source: "observed" as const };
}
