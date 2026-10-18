import type { FeedItem, FeedView, Window } from "./types";

export type Filters = {
  maxAgeMin: number | null;
  minMcap: number | null;
  maxMcap: number | null;
  minLiquidity: number | null;
  /** Volume / txns / buy share are measured over the selected timeframe. */
  minVolume: number | null;
  minTxns: number | null;
  minBuyPct: number | null;
  needTwitter: boolean;
  needTelegram: boolean;
  needWebsite: boolean;
  needAnySocial: boolean;
};

const NONE: Filters = {
  maxAgeMin: null,
  minMcap: null,
  maxMcap: null,
  minLiquidity: null,
  minVolume: null,
  minTxns: null,
  minBuyPct: null,
  needTwitter: false,
  needTelegram: false,
  needWebsite: false,
  needAnySocial: false,
};

/**
 * Starting points per view. "New" screens out the dead-on-arrival launches: a coin needs
 * some market cap, volume and trades in the window before it's worth looking at.
 */
export const DEFAULT_FILTERS: Record<FeedView, Filters> = {
  new: { ...NONE, maxAgeMin: 60, minMcap: 6_000, minVolume: 1_000, minTxns: 20, needAnySocial: true },
  stretch: { ...NONE, minTxns: 10 },
  migrated: { ...NONE, minMcap: 15_000, minVolume: 1_000 },
  trending: { ...NONE },
};

export function countActive(f: Filters): number {
  return Object.entries(f).filter(([, v]) => v !== null && v !== false).length;
}

export function applyFilters(items: FeedItem[], f: Filters, w: Window): FeedItem[] {
  const now = Date.now();
  return items.filter((it) => {
    const s = it.windows[w];
    const txns = s.buys + s.sells;
    const mcap = it.pair.marketCap;
    if (f.maxAgeMin !== null && it.createdAt && now - it.createdAt > f.maxAgeMin * 60_000) return false;
    if (f.minMcap !== null && mcap < f.minMcap) return false;
    if (f.maxMcap !== null && mcap > f.maxMcap) return false;
    // Bonding curves have no pool liquidity, so the liquidity floor only applies to real pools.
    if (f.minLiquidity !== null && it.curveProgress === null && it.pair.liquidityUsd < f.minLiquidity) return false;
    if (f.minVolume !== null && s.volume < f.minVolume) return false;
    if (f.minTxns !== null && txns < f.minTxns) return false;
    if (f.minBuyPct !== null && (txns === 0 || (s.buys / txns) * 100 < f.minBuyPct)) return false;
    const { twitter, telegram, website } = it.socials;
    if (f.needTwitter && !twitter) return false;
    if (f.needTelegram && !telegram) return false;
    if (f.needWebsite && !website) return false;
    if (f.needAnySocial && !twitter && !telegram && !website) return false;
    return true;
  });
}
