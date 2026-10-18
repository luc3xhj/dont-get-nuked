// Pulse: the coin list, built the way Axiom's Pulse works. Three columns by lifecycle stage
// (New Pairs, Final Stretch, Migrated) and Axiom's own filter set, with min/max ranges that hide
// coins where a few wallets already own the supply or nobody is trading. Filter names follow
// Axiom's /pulse request (age, top10Holders, devHolding, snipers, insiders, bundle, holders,
// bondingCurve, liquidity, volume, marketCap, txns, numBuys, numSells, socials, dexPaid, keywords).
//
// Data is free and staged: list data (age, market cap, curve, socials) for every coin; DexScreener
// activity (volume, txns, buys, sells, liquidity, dex paid) for coins that survive; RugCheck holder
// data (holders, top 10, dev, insiders) for coins that still survive; snipers and bundles from the
// launch tape once a coin is deep-watched. A filter we can't check yet leaves the coin "checking",
// never "passed".
import { db, journal, saveReport } from "./db";
import { budget } from "./http";
import { dsMarket, holderReport } from "./sources";
import { coins, laneOf, pairAddress, type CoinState } from "./state";
import type { Lane } from "./state";

export type Range = { min: number | null; max: number | null };
export type PulseFilters = {
  searchKeywords: string[];
  excludeKeywords: string[];
  /** Minutes since creation. */
  age: Range;
  top10Holders: Range;
  devHolding: Range;
  snipers: Range;
  insiders: Range;
  bundle: Range;
  holders: Range;
  /** Bonding-curve progress, 0–100. */
  bondingCurve: Range;
  liquidity: Range;
  /** USD volume over the last hour. */
  volume: Range;
  marketCap: Range;
  /** Transactions (buys + sells) over the last hour. */
  txns: Range;
  numBuys: Range;
  numSells: Range;
  twitter: boolean;
  website: boolean;
  telegram: boolean;
  dexPaid: boolean;
  /** Not in Axiom: require at least one of X, website or Telegram (a common Axiom setup). */
  anySocial: boolean;
};
export type ColumnId = "newPairs" | "finalStretch" | "migrated";
export const COLUMNS: { id: ColumnId; label: string; lane: Lane }[] = [
  { id: "newPairs", label: "New Pairs", lane: "new" },
  { id: "finalStretch", label: "Final Stretch", lane: "stretch" },
  { id: "migrated", label: "Migrated", lane: "migrated" },
];

const R = (min: number | null = null, max: number | null = null): Range => ({ min, max });
const EMPTY: PulseFilters = {
  searchKeywords: [],
  excludeKeywords: [],
  age: R(),
  top10Holders: R(),
  devHolding: R(),
  snipers: R(),
  insiders: R(),
  bundle: R(),
  holders: R(),
  bondingCurve: R(),
  liquidity: R(),
  volume: R(),
  marketCap: R(),
  txns: R(),
  numBuys: R(),
  numSells: R(),
  twitter: false,
  website: false,
  telegram: false,
  dexPaid: false,
  anySocial: false,
};

/**
 * Starting presets from published Axiom setups (Meme Coin Navigator's New Pairs / Final Stretch
 * settings, and the common "top 10 under 30–40%, dev and snipers under 10%" ceilings). Every value
 * is editable in the app; these are starting points, not proven thresholds.
 */
export const PRESETS: Record<ColumnId, PulseFilters> = {
  newPairs: {
    ...EMPTY,
    top10Holders: R(null, 30),
    devHolding: R(null, 10),
    snipers: R(null, 10),
    insiders: R(null, 10),
    bundle: R(null, 10),
    holders: R(15),
    volume: R(500),
    marketCap: R(5_000),
    anySocial: true,
  },
  finalStretch: {
    ...EMPTY,
    age: R(null, 180),
    top10Holders: R(null, 40),
    devHolding: R(null, 10),
    insiders: R(null, 10),
    holders: R(50),
    volume: R(7_000),
    marketCap: R(12_000),
    anySocial: true,
  },
  migrated: {
    ...EMPTY,
    top10Holders: R(null, 40),
    devHolding: R(null, 10),
    insiders: R(null, 10),
    holders: R(100),
    liquidity: R(10_000),
    volume: R(10_000),
    marketCap: R(15_000),
  },
};

db.exec("CREATE TABLE IF NOT EXISTS pulse_filters (col TEXT PRIMARY KEY, data TEXT NOT NULL)");
const filters = new Map<ColumnId, PulseFilters>();
for (const c of COLUMNS) {
  const row = db.prepare("SELECT data FROM pulse_filters WHERE col = ?").get(c.id) as { data: string } | undefined;
  filters.set(c.id, row ? { ...EMPTY, ...JSON.parse(row.data) } : PRESETS[c.id]);
}
export const filtersFor = (col: ColumnId) => filters.get(col)!;

const range = (v: unknown): Range => {
  const n = (x: unknown) => (x === null || x === undefined || x === "" || !Number.isFinite(Number(x)) ? null : Number(x));
  const o = (v ?? {}) as { min?: unknown; max?: unknown };
  return { min: n(o.min), max: n(o.max) };
};
const words = (v: unknown) =>
  (Array.isArray(v) ? v : String(v ?? "").split(","))
    .map((w) => String(w).trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 20);

/** Saves a column's filters (validated), or resets them to the preset. */
export function setFilters(col: ColumnId, input: Record<string, unknown> | "preset"): PulseFilters {
  let f: PulseFilters;
  if (input === "preset") f = PRESETS[col];
  else {
    f = { ...EMPTY };
    for (const k of RANGE_KEYS) f[k] = range(input[k]);
    for (const k of ["twitter", "website", "telegram", "dexPaid", "anySocial"] as const) f[k] = !!input[k];
    f.searchKeywords = words(input.searchKeywords);
    f.excludeKeywords = words(input.excludeKeywords);
  }
  filters.set(col, f);
  db.prepare("INSERT OR REPLACE INTO pulse_filters (col, data) VALUES (?, ?)").run(col, JSON.stringify(f));
  journal("pulse_filters", null, { col, filters: f });
  for (const s of coins.values()) evaluatePulse(s);
  return f;
}

// ---------- metrics ----------

export type PulseMetrics = {
  ageMin: number;
  marketCap: number | null;
  bondingCurve: number | null;
  athMcap: number | null;
  liquidity: number | null;
  volume: number | null;
  txns: number | null;
  numBuys: number | null;
  numSells: number | null;
  holders: number | null;
  top10Holders: number | null;
  devHolding: number | null;
  insiders: number | null;
  snipers: number | null;
  bundle: number | null;
  dexPaid: boolean | null;
  twitter: boolean;
  website: boolean;
  telegram: boolean;
};

const MARKET_MAX_AGE = 2 * 60_000;
const HOLDERS_MAX_AGE = 10 * 60_000;

export function metricsOf(s: CoinState, now = Date.now()): PulseMetrics {
  const c = s.coin;
  const m = s.market && now - s.market.at <= MARKET_MAX_AGE ? s.market : null;
  const h = s.holders && now - s.holders.at <= HOLDERS_MAX_AGE ? s.holders : null;
  const f = s.features;
  const launchKnown = !!f?.cohortsReliable;
  return {
    ageMin: (now - c.createdAt) / 60_000,
    marketCap: m?.mcapUsd || s.quote?.mcapUsd || c.mcapUsd || null,
    bondingCurve: c.stage === "migrated" ? 100 : c.curveProgress != null ? c.curveProgress * 100 : null,
    athMcap: c.athMcapUsd,
    liquidity: m ? m.liquidityUsd : null,
    volume: m ? m.volumeUsd.h1 : null,
    txns: m ? m.buys.h1 + m.sells.h1 : null,
    numBuys: m ? m.buys.h1 : null,
    numSells: m ? m.sells.h1 : null,
    holders: h?.totalHolders ?? null,
    top10Holders: h ? h.top10ExPoolPct : null,
    devHolding: h?.creatorPct ?? (launchKnown ? f!.cohorts.dev.heldPct : null),
    insiders: h ? (h.insiderPct ?? 0) : null,
    snipers: launchKnown ? f!.cohorts.snipers.heldPct : null,
    bundle: launchKnown ? f!.cohorts.bundles.heldPct : null,
    dexPaid: m ? m.dexPaid : null,
    twitter: !!c.socials.twitter,
    website: !!c.socials.website,
    telegram: !!c.socials.telegram,
  };
}

// ---------- evaluation ----------

const RANGE_KEYS = [
  "age",
  "top10Holders",
  "devHolding",
  "snipers",
  "insiders",
  "bundle",
  "holders",
  "bondingCurve",
  "liquidity",
  "volume",
  "marketCap",
  "txns",
  "numBuys",
  "numSells",
] as const;
type RangeKey = (typeof RANGE_KEYS)[number];

export const FILTER_LABEL: Record<RangeKey | "twitter" | "website" | "telegram" | "dexPaid" | "anySocial" | "keywords", string> = {
  age: "Age (min)",
  top10Holders: "Top 10 holders %",
  devHolding: "Dev holding %",
  snipers: "Snipers %",
  insiders: "Insiders %",
  bundle: "Bundle %",
  holders: "Holders",
  bondingCurve: "Bonding curve %",
  liquidity: "Liquidity $",
  volume: "Volume $ (1h)",
  marketCap: "Market cap $",
  txns: "Txns (1h)",
  numBuys: "Buys (1h)",
  numSells: "Sells (1h)",
  twitter: "X link",
  website: "Website",
  telegram: "Telegram",
  dexPaid: "Dex paid",
  anySocial: "Any social",
  keywords: "Keywords",
};

const metricFor = (m: PulseMetrics, k: RangeKey): number | null => (k === "age" ? m.ageMin : m[k]);

export type PulseEval = { column: ColumnId; status: "pass" | "checking" | "fail"; failed: string[]; unknown: string[]; at: number };

const COLUMN_OF: Record<Lane, ColumnId> = { new: "newPairs", stretch: "finalStretch", migrated: "migrated" };

/** Applies the coin's column filters. Unknown values keep it "checking" until they're measured. */
export function evaluatePulse(s: CoinState, now = Date.now()): PulseEval | null {
  const lane = laneOf(s.coin, now);
  if (!lane) {
    s.pulse = null;
    return null;
  }
  const column = COLUMN_OF[lane];
  const f = filtersFor(column);
  const m = metricsOf(s, now);
  const failed: string[] = [];
  const unknown: string[] = [];
  for (const k of RANGE_KEYS) {
    const r = f[k];
    if (r.min === null && r.max === null) continue;
    const v = metricFor(m, k);
    if (v === null) unknown.push(k);
    else if ((r.min !== null && v < r.min) || (r.max !== null && v > r.max)) failed.push(k);
  }
  for (const k of ["twitter", "website", "telegram"] as const) if (f[k] && !m[k]) failed.push(k);
  if (f.anySocial && !m.twitter && !m.website && !m.telegram) failed.push("anySocial");
  if (f.dexPaid) {
    if (m.dexPaid === null) unknown.push("dexPaid");
    else if (!m.dexPaid) failed.push("dexPaid");
  }
  const text = `${s.coin.name} ${s.coin.symbol}`.toLowerCase();
  if (f.searchKeywords.length && !f.searchKeywords.some((w) => text.includes(w))) failed.push("keywords");
  if (f.excludeKeywords.some((w) => text.includes(w))) failed.push("keywords");
  const e: PulseEval = { column, status: failed.length ? "fail" : unknown.length ? "checking" : "pass", failed, unknown, at: now };
  s.pulse = e;
  return e;
}

// ---------- enrichment ----------

const HOLDER_KEYS = new Set(["holders", "top10Holders", "devHolding", "insiders"]);
const MARKET_KEYS = new Set(["liquidity", "volume", "txns", "numBuys", "numSells", "dexPaid", "marketCap"]);
const holderTried = new Map<string, number>();
const holdersInFlight = new Set<string>();

/** Fetches what the surviving coins still need: activity in batches, then holder data for the best few. */
export async function pulseTick(now = Date.now()) {
  const live = [...coins.values()].filter((s) => evaluatePulse(s, now)?.status !== "fail" && s.pulse);
  // Activity: 30 pairs per DexScreener call, oldest data first.
  const needMarket = live
    .filter((s) => !s.market || now - s.market.at > 60_000)
    .sort((a, b) => (a.market?.at ?? 0) - (b.market?.at ?? 0))
    .slice(0, 30);
  // (one batch per 3s tick: up to 600 coin refreshes a minute, a third of DexScreener's budget)
  if (needMarket.length && budget("https://api.dexscreener.com/") >= 2) {
    const byPair = new Map(needMarket.map((s) => [pairAddress(s.coin), s]));
    try {
      const got = await dsMarket([...byPair.keys()]);
      for (const [pair, s] of byPair) {
        // Not indexed yet: record an empty sample so the coin isn't retried every tick.
        s.market = got[pair] ?? { at: now, volumeUsd: { m5: 0, h1: 0, h24: 0 }, buys: { m5: 0, h1: 0, h24: 0 }, sells: { m5: 0, h1: 0, h24: 0 }, liquidityUsd: 0, mcapUsd: 0, dexPaid: false };
        if (!got[pair]) s.market.missing = true;
        evaluatePulse(s, now);
      }
    } catch {
      // Try again next tick.
    }
  }
  // Holder data: only coins that pass everything else, newest evidence first, within RugCheck's budget.
  const needHolders = live
    .filter(
      (s) =>
        s.pulse?.status === "checking" &&
        s.pulse.unknown.some((k) => HOLDER_KEYS.has(k)) &&
        !s.pulse.unknown.some((k) => MARKET_KEYS.has(k)) &&
        now - (holderTried.get(s.coin.mint) ?? 0) > 5 * 60_000,
    )
    .sort((a, b) => (b.coin.mcapUsd ?? 0) - (a.coin.mcapUsd ?? 0))
    .slice(0, 2);
  // Holder lookups can take ~20s each, so they run in the background and never hold up the activity batches.
  for (const s of needHolders) {
    if (holdersInFlight.size >= 2 || budget("https://api.rugcheck.xyz/") < 3) break;
    holderTried.set(s.coin.mint, now);
    holdersInFlight.add(s.coin.mint);
    holderReport(s.coin)
      .then((h) => {
        s.holders = h;
        saveReport(s.coin.mint, "holders", h.at, h);
        evaluatePulse(s);
      })
      .catch(() => {
        // Stays "checking"; retried after 5 minutes.
      })
      .finally(() => holdersInFlight.delete(s.coin.mint));
  }
}

// ---------- report ----------

export function pulseReport(now = Date.now()) {
  const all = [...coins.values()].filter((s) => s.pulse);
  return {
    at: now,
    note: "Axiom's Pro Traders filter isn't available: it relies on Axiom's own data on which wallets use trading terminals.",
    labels: FILTER_LABEL,
    columns: COLUMNS.map((c) => {
      const inCol = all.filter((s) => s.pulse!.column === c.id);
      const order = (s: CoinState) =>
        c.id === "newPairs" ? s.coin.createdAt : c.id === "finalStretch" ? (s.coin.curveProgress ?? 0) : (s.coin.migratedAt ?? s.coin.createdAt);
      const row = (s: CoinState) => ({
        mint: s.coin.mint,
        symbol: s.coin.symbol,
        name: s.coin.name,
        createdAt: s.coin.createdAt,
        hot: s.hot,
        status: s.pulse!.status,
        failed: s.pulse!.failed,
        unknown: s.pulse!.unknown,
        metrics: metricsOf(s, now),
      });
      const failReasons: Record<string, number> = {};
      for (const s of inCol) for (const k of s.pulse!.failed) failReasons[k] = (failReasons[k] ?? 0) + 1;
      return {
        id: c.id,
        label: c.label,
        filters: filtersFor(c.id),
        preset: PRESETS[c.id],
        counts: {
          seen: inCol.length,
          pass: inCol.filter((s) => s.pulse!.status === "pass").length,
          checking: inCol.filter((s) => s.pulse!.status === "checking").length,
          fail: inCol.filter((s) => s.pulse!.status === "fail").length,
        },
        failReasons,
        coins: inCol
          .filter((s) => s.pulse!.status !== "fail")
          .sort((a, b) => (a.pulse!.status === b.pulse!.status ? order(b) - order(a) : a.pulse!.status === "pass" ? -1 : 1))
          .slice(0, 60)
          .map(row),
      };
    }),
  };
}
