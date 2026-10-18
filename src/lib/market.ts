// Server-side market data for the web app (SOL price, chart candles). All calls go through a
// small in-memory cache so many browser polls collapse into few upstream requests.
import type { Candle } from "./types";

const GT = "https://api.geckoterminal.com/api/v2/networks/solana";
const DS = "https://api.dexscreener.com";
const WSOL = "So11111111111111111111111111111111111111112";

const cache = new Map<string, { at: number; value: Promise<unknown> }>();
const lastGood = new Map<string, unknown>();

/** TTL cache; if a refresh fails (e.g. 429), keep serving the last good value. */
function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
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

async function getJson(url: string) {
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0" }, cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

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
