// Discover feed: builds screened rows from pump.fun (coin universe, socials, curve state)
// and DexScreener (txns / volume / price change windows), plus GeckoTerminal trending.
// Server-only. pump.fun's frontend API is unofficial, so every call degrades gracefully.
import { cached, DS, getJson, getTrendingPoolAddresses, mapPair, num, type TrendingDuration, WSOL } from "./market";
import type { FeedItem, FeedView, Pair, Window, WindowStats } from "./types";

const PUMP = "https://frontend-api-v3.pump.fun";
const NATIVE_SOL = "11111111111111111111111111111111";
// Standard pump.fun curve: 793.1M tokens sell before graduation, 279.9M stay virtual.
const CURVE_SELLABLE = 793_100_000;
const CURVE_END_V_TOKENS = 279_900_000;
const TOKEN_DECIMALS = 1e6;
const LAMPORTS = 1e9;

type PumpCoin = {
  mint: string;
  name: string;
  symbol: string;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
  bonding_curve: string;
  pump_swap_pool: string | null;
  complete: boolean;
  created_timestamp: number;
  last_trade_timestamp: number | null;
  virtual_sol_reserves: number;
  virtual_token_reserves: number;
  real_token_reserves: number;
  total_supply: number;
  usd_market_cap: number;
  ath_market_cap: number | null;
  reply_count: number;
  is_currently_live: boolean;
  quote_mint: string | null;
  nsfw: boolean;
};

const isSolQuoted = (c: PumpCoin) => !c.quote_mint || c.quote_mint === WSOL || c.quote_mint === NATIVE_SOL;
/** Our AMM model assumes the standard curve; skip variants with other parameters. */
const isStandardCurve = (c: PumpCoin) =>
  Math.abs(c.virtual_token_reserves - c.real_token_reserves - CURVE_END_V_TOKENS * TOKEN_DECIMALS) < TOKEN_DECIMALS * 1_000_000;

function pumpList(sort: string, extra = ""): Promise<PumpCoin[]> {
  return cached(`pump:${sort}${extra}`, 10_000, async () => {
    const json = await getJson(`${PUMP}/coins/?offset=0&limit=100&sort=${sort}&order=DESC&includeNsfw=false${extra}`);
    if (!Array.isArray(json)) throw new Error("Unexpected pump.fun response");
    return json as PumpCoin[];
  });
}

// Rolling memory of coins seen recently, so "New" covers the last hours rather than
// only the ~100 most recent launches (a few minutes' worth). Resets on server restart.
const tracked = new Map<string, PumpCoin>();
const TRACK_MS = 24 * 3600_000;
const TRACK_MAX = 1500;

async function refreshUniverse(): Promise<void> {
  return cached("pump:universe", 10_000, async () => {
    const lists = await Promise.all(
      [pumpList("created_timestamp"), pumpList("last_trade_timestamp"), pumpList("market_cap", "&complete=false")].map((p) =>
        p.catch(() => [] as PumpCoin[])
      )
    );
    for (const c of lists.flat()) if (c?.mint && !c.nsfw && isSolQuoted(c)) tracked.set(c.mint, c);
    const now = Date.now();
    for (const [mint, c] of tracked) if (now - c.created_timestamp > TRACK_MS) tracked.delete(mint);
    if (tracked.size > TRACK_MAX) {
      const byActivity = [...tracked.values()].sort((a, b) => (b.last_trade_timestamp ?? 0) - (a.last_trade_timestamp ?? 0));
      for (const c of byActivity.slice(TRACK_MAX)) tracked.delete(c.mint);
    }
  });
}

// DexScreener raw pairs, cached per pair so overlapping views share lookups.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dsCache = new Map<string, { at: number; raw: any | null }>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function dsPairs(addresses: string[]): Promise<Record<string, any>> {
  const now = Date.now();
  const stale = [...new Set(addresses)].filter((a) => !dsCache.has(a) || now - dsCache.get(a)!.at > 15_000);
  const batches: string[][] = [];
  for (let i = 0; i < stale.length; i += 30) batches.push(stale.slice(i, i + 30));
  await Promise.all(
    batches.map(async (batch) => {
      try {
        const json = await getJson(`${DS}/latest/dex/pairs/solana/${batch.join(",")}`);
        const found = new Map<string, unknown>((json.pairs ?? []).map((p: { pairAddress: string }) => [p.pairAddress, p]));
        for (const a of batch) dsCache.set(a, { at: Date.now(), raw: found.get(a) ?? null });
      } catch {
        // Keep whatever we had; rows fall back to pump.fun data.
      }
    })
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: Record<string, any> = {};
  for (const a of addresses) {
    const hit = dsCache.get(a)?.raw;
    if (hit) out[a] = hit;
  }
  if (dsCache.size > 5000) for (const [k, v] of dsCache) if (now - v.at > 600_000) dsCache.delete(k);
  return out;
}

const EMPTY: WindowStats = { volume: 0, buys: 0, sells: 0, change: 0 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function windowsFrom(raw: any | null): Record<Window, WindowStats> {
  const w = (k: Window): WindowStats =>
    raw
      ? { volume: num(raw.volume?.[k]), buys: num(raw.txns?.[k]?.buys), sells: num(raw.txns?.[k]?.sells), change: num(raw.priceChange?.[k]) }
      : EMPTY;
  return { m5: w("m5"), h1: w("h1"), h6: w("h6"), h24: w("h24") };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dsSocials(raw: any | null) {
  const socials: { type: string; url: string }[] = raw?.info?.socials ?? [];
  return {
    twitter: socials.find((s) => s.type === "twitter")?.url ?? null,
    telegram: socials.find((s) => s.type === "telegram")?.url ?? null,
    website: raw?.info?.websites?.[0]?.url ?? null,
  };
}

const cleanUrl = (u: string | null | undefined) => (u && /^https?:\/\//.test(u) ? u : null);

/** pump.fun coin -> tradeable pair, preferring DexScreener's live view when it has one. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pumpItem(c: PumpCoin, raw: any | null, solUsd: number): FeedItem {
  const pairAddress = c.complete && c.pump_swap_pool ? c.pump_swap_pool : c.bonding_curve;
  const vSol = c.virtual_sol_reserves / LAMPORTS;
  const vTok = c.virtual_token_reserves / TOKEN_DECIMALS;
  const priceNative = vTok ? vSol / vTok : 0;
  // pump.fun's CDN serves small thumbnails; the raw IPFS links are slow and rate-limited.
  const image = `https://images.pump.fun/coin-image/${c.mint}?variant=86x86`;
  const pair: Pair = raw
    ? { ...mapPair(raw), imageUrl: raw.info?.imageUrl ?? image }
    : {
        pairAddress,
        tokenAddress: c.mint,
        name: c.name,
        symbol: c.symbol,
        dex: c.complete ? "pumpswap" : "pumpfun",
        imageUrl: image,
        url: `https://pump.fun/coin/${c.mint}`,
        priceUsd: priceNative * solUsd,
        priceNative,
        quoteSymbol: "SOL",
        liquidityUsd: 0,
        reserveBase: 0,
        reserveQuote: 0,
        fdv: c.usd_market_cap,
        marketCap: c.usd_market_cap,
        volume24h: 0,
        change: { m5: 0, h1: 0, h6: 0, h24: 0 },
        txns24h: { buys: 0, sells: 0 },
        createdAt: c.created_timestamp,
      };
  const ds = dsSocials(raw);
  return {
    pair,
    windows: windowsFrom(raw),
    socials: {
      twitter: cleanUrl(c.twitter) ?? ds.twitter,
      telegram: cleanUrl(c.telegram) ?? ds.telegram,
      website: cleanUrl(c.website) ?? ds.website,
    },
    dexPaid: !!raw?.info,
    boosts: num(raw?.boosts?.active),
    replies: c.reply_count ?? 0,
    athMarketCapUsd: c.ath_market_cap ?? null,
    live: !!c.is_currently_live,
    curveProgress: c.complete ? null : Math.min(1, Math.max(0, 1 - c.real_token_reserves / TOKEN_DECIMALS / CURVE_SELLABLE)),
    createdAt: c.created_timestamp,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function dsItem(raw: any): FeedItem {
  const pair = mapPair(raw);
  return {
    pair,
    windows: windowsFrom(raw),
    socials: dsSocials(raw),
    dexPaid: !!raw.info,
    boosts: num(raw.boosts?.active),
    replies: null,
    athMarketCapUsd: null,
    live: false,
    curveProgress: null,
    createdAt: pair.createdAt,
  };
}

const VIEW_LIMIT = 150;

export function getFeed(view: FeedView, duration: TrendingDuration, solUsd: number): Promise<FeedItem[]> {
  const key = view === "trending" ? `feed:trending:${duration}` : `feed:${view}`;
  return cached(key, 8_000, async () => {
    if (view === "trending") {
      const addresses = (await getTrendingPoolAddresses(duration)).slice(0, 40);
      const raws = await dsPairs(addresses);
      return addresses.filter((a) => raws[a]).map((a) => dsItem(raws[a]));
    }

    await refreshUniverse();
    const now = Date.now();
    let coins = [...tracked.values()].filter(isStandardCurve);
    if (view === "new") {
      coins = coins
        .filter((c) => now - c.created_timestamp < 6 * 3600_000)
        .sort((a, b) => b.created_timestamp - a.created_timestamp);
    } else if (view === "stretch") {
      coins = coins
        .filter((c) => !c.complete && c.real_token_reserves / TOKEN_DECIMALS / CURVE_SELLABLE < 0.5)
        .sort((a, b) => a.real_token_reserves - b.real_token_reserves);
    } else {
      coins = coins
        .filter((c) => c.complete && c.pump_swap_pool)
        .sort((a, b) => (b.last_trade_timestamp ?? 0) - (a.last_trade_timestamp ?? 0));
    }
    coins = coins.slice(0, VIEW_LIMIT);
    const raws = await dsPairs(coins.map((c) => (c.complete && c.pump_swap_pool ? c.pump_swap_pool : c.bonding_curve)));
    return coins.map((c) => pumpItem(c, raws[c.complete && c.pump_swap_pool ? c.pump_swap_pool : c.bonding_curve] ?? null, solUsd));
  });
}

export function searchFeed(q: string): Promise<FeedItem[]> {
  return cached(`feed:search:${q.toLowerCase()}`, 30_000, async () => {
    const json = await getJson(`${DS}/latest/dex/search?q=${encodeURIComponent(q)}`);
    return (json.pairs ?? [])
      .filter((p: { chainId: string; baseToken: { address: string } }) => p.chainId === "solana" && p.baseToken.address !== WSOL)
      .slice(0, 30)
      .map(dsItem);
  });
}
