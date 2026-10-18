// Server-side market data access. All calls go through a small in-memory cache
// so many browser polls collapse into few upstream requests (rate limits:
// GeckoTerminal ~30/min, DexScreener ~300/min).
import type { Candle, Pair } from "./types";

const GT = "https://api.geckoterminal.com/api/v2/networks/solana";
export const DS = "https://api.dexscreener.com";
export const WSOL = "So11111111111111111111111111111111111111112";

const cache = new Map<string, { at: number; value: Promise<unknown> }>();
const lastGood = new Map<string, unknown>();

/** TTL cache; if a refresh fails (e.g. 429), keep serving the last good value. */
export function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = load().then(
    (v) => {
      lastGood.set(key, v);
      return v;
    },
    (e) => {
      cache.delete(key);
      if (lastGood.has(key)) return lastGood.get(key) as T;
      throw e;
    }
  );
  cache.set(key, { at: Date.now(), value });
  return value;
}

export async function getJson(url: string) {
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0" }, cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
}

export const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export type TrendingDuration = "5m" | "1h" | "6h" | "24h";

/** Addresses of GeckoTerminal's trending Solana pools (meme side only), best first. */
export function getTrendingPoolAddresses(duration: TrendingDuration): Promise<string[]> {
  return cached(`gt:trending:${duration}`, 60_000, async () => {
    const results = await Promise.all(
      [1, 2].map((p) => getJson(`${GT}/trending_pools?duration=${duration}&page=${p}`).catch((e: Error) => e))
    );
    const pages = results.filter((r) => !(r instanceof Error));
    // Usually a 429; throwing lets the cache keep serving the last good list.
    if (pages.length === 0) throw results[0];
    const out: string[] = [];
    for (const page of pages)
      for (const d of page.data ?? []) {
        // Skip pools where SOL is the base (e.g. SOL/USDC) – we want meme tokens.
        if (String(d.relationships?.base_token?.data?.id ?? "").endsWith(WSOL)) continue;
        if (!out.includes(d.attributes.address)) out.push(d.attributes.address);
      }
    return out;
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapPair(p: any): Pair {
  return {
    pairAddress: p.pairAddress,
    tokenAddress: p.baseToken.address,
    name: p.baseToken.name,
    symbol: p.baseToken.symbol,
    dex: p.dexId,
    imageUrl: p.info?.imageUrl ?? null,
    url: p.url,
    priceUsd: num(p.priceUsd),
    priceNative: num(p.priceNative),
    quoteSymbol: p.quoteToken?.symbol ?? "",
    liquidityUsd: num(p.liquidity?.usd),
    reserveBase: num(p.liquidity?.base),
    reserveQuote: num(p.liquidity?.quote),
    fdv: num(p.fdv),
    marketCap: num(p.marketCap) || num(p.fdv),
    volume24h: num(p.volume?.h24),
    change: {
      m5: num(p.priceChange?.m5),
      h1: num(p.priceChange?.h1),
      h6: num(p.priceChange?.h6),
      h24: num(p.priceChange?.h24),
    },
    txns24h: { buys: num(p.txns?.h24?.buys), sells: num(p.txns?.h24?.sells) },
    createdAt: p.pairCreatedAt ?? null,
  };
}

/** Single pool from GeckoTerminal, for brand-new pairs DexScreener hasn't indexed yet. */
function getGeckoPair(address: string): Promise<Pair | null> {
  return cached(`gt:pool:${address}`, 10_000, async () => {
    const json = await getJson(`${GT}/pools/${address}?include=base_token`);
    const d = json.data;
    if (!d) return null;
    const a = d.attributes;
    const base = (json.included ?? []).find((t: { type: string }) => t.type === "token")?.attributes ?? {};
    const dex: string = d.relationships?.dex?.data?.id ?? "";
    const quoteIsSol = String(d.relationships?.quote_token?.data?.id ?? "").endsWith(WSOL);
    const ch = a.price_change_percentage ?? {};
    return {
      pairAddress: a.address,
      tokenAddress: base.address ?? String(d.relationships?.base_token?.data?.id ?? "").replace(/^solana_/, ""),
      name: base.name ?? String(a.name).split(" / ")[0],
      symbol: base.symbol ?? String(a.name).split(" / ")[0],
      // Normalise to DexScreener's dex ids so the rest of the app treats both sources alike.
      dex: dex === "pump-fun" ? "pumpfun" : dex,
      imageUrl: base.image_url && base.image_url !== "missing.png" ? base.image_url : null,
      url: `https://www.geckoterminal.com/solana/pools/${a.address}`,
      priceUsd: num(a.base_token_price_usd),
      priceNative: quoteIsSol ? num(a.base_token_price_native_currency) : num(a.base_token_price_quote_token),
      quoteSymbol: String(a.name).split(" / ")[1] ?? "",
      liquidityUsd: num(a.reserve_in_usd),
      reserveBase: 0,
      reserveQuote: 0,
      fdv: num(a.fdv_usd),
      marketCap: num(a.market_cap_usd) || num(a.fdv_usd),
      volume24h: num(a.volume_usd?.h24),
      change: { m5: num(ch.m5), h1: num(ch.h1), h6: num(ch.h6), h24: num(ch.h24) },
      txns24h: { buys: num(a.transactions?.h24?.buys), sells: num(a.transactions?.h24?.sells) },
      createdAt: a.pool_created_at ? Date.parse(a.pool_created_at) : null,
    };
  });
}

/** Up to 30 pair addresses per DexScreener call, falling back to GeckoTerminal for unindexed ones. */
export function getPairs(addresses: string[]): Promise<Pair[]> {
  const unique = [...new Set(addresses)].sort().slice(0, 30);
  if (unique.length === 0) return Promise.resolve([]);
  return cached(`ds:pairs:${unique.join(",")}`, 2_000, async () => {
    const json = await getJson(`${DS}/latest/dex/pairs/solana/${unique.join(",")}`);
    const pairs: Pair[] = (json.pairs ?? []).map(mapPair);
    const found = new Set(pairs.map((p) => p.pairAddress));
    // DexScreener lags brand-new launches by a minute or so; GeckoTerminal usually has them already.
    const missing = unique.filter((a) => !found.has(a)).slice(0, 3);
    const fallback = await Promise.all(missing.map((a) => getGeckoPair(a).catch(() => null)));
    return [...pairs, ...fallback.filter((p): p is Pair => p !== null)];
  });
}

export function getSolPrice(): Promise<number> {
  return cached("ds:sol", 15_000, async () => {
    const json = await getJson(`${DS}/latest/dex/tokens/${WSOL}`);
    const best = (json.pairs ?? [])
      .filter((p: { chainId: string; baseToken: { address: string }; quoteToken: { symbol: string } }) =>
        p.chainId === "solana" && p.baseToken.address === WSOL && /^USD/.test(p.quoteToken.symbol))
      .sort((a: { liquidity?: { usd?: number } }, b: { liquidity?: { usd?: number } }) =>
        num(b.liquidity?.usd) - num(a.liquidity?.usd))[0];
    if (!best) throw new Error("No SOL/USD pair found");
    return num(best.priceUsd);
  });
}

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
const TF: Record<Timeframe, [string, number]> = {
  "1m": ["minute", 1],
  "5m": ["minute", 5],
  "15m": ["minute", 15],
  "1h": ["hour", 1],
  "4h": ["hour", 4],
  "1d": ["day", 1],
};
export const isTimeframe = (t: string): t is Timeframe => t in TF;

export function getCandles(pairAddress: string, tf: Timeframe): Promise<Candle[]> {
  const [unit, agg] = TF[tf];
  return cached(`gt:ohlcv:${pairAddress}:${tf}`, 30_000, async () => {
    const json = await getJson(
      `${GT}/pools/${pairAddress}/ohlcv/${unit}?aggregate=${agg}&limit=300&currency=usd&token=base`
    );
    const list: number[][] = json.data?.attributes?.ohlcv_list ?? [];
    return list
      .map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }))
      .sort((a, b) => a.time - b.time);
  });
}

/**
 * For each token, the deepest non-bonding-curve SOL pool, if it has one. A pump.fun
 * token that shows up here has graduated (its curve pair stops trading).
 */
export function getGraduatedPools(tokens: string[]): Promise<Record<string, Pair>> {
  const unique = [...new Set(tokens)].sort().slice(0, 30);
  if (unique.length === 0) return Promise.resolve({});
  return cached(`ds:grad:${unique.join(",")}`, 15_000, async () => {
    const json = await getJson(`${DS}/tokens/v1/solana/${unique.join(",")}`);
    const best: Record<string, Pair> = {};
    for (const raw of Array.isArray(json) ? json : []) {
      if (raw.dexId === "pumpfun" || raw.quoteToken?.address !== WSOL) continue;
      const p = mapPair(raw);
      if (!p.liquidityUsd || !unique.includes(p.tokenAddress)) continue;
      if (!best[p.tokenAddress] || p.liquidityUsd > best[p.tokenAddress].liquidityUsd) best[p.tokenAddress] = p;
    }
    return best;
  });
}
