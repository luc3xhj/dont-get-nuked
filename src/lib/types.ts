export type Pair = {
  pairAddress: string;
  tokenAddress: string;
  name: string;
  symbol: string;
  dex: string;
  imageUrl: string | null;
  url: string;
  priceUsd: number;
  priceNative: number;
  quoteSymbol: string;
  liquidityUsd: number;
  /** Real pool reserves: base = meme token, quote = SOL/USDC/etc. */
  reserveBase: number;
  reserveQuote: number;
  fdv: number;
  marketCap: number;
  volume24h: number;
  change: { m5: number; h1: number; h6: number; h24: number };
  txns24h: { buys: number; sells: number };
  createdAt: number | null;
};

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

export const WINDOWS = ["m5", "h1", "h6", "h24"] as const;
export type Window = (typeof WINDOWS)[number];
export type WindowStats = { volume: number; buys: number; sells: number; change: number };

export type FeedView = "new" | "stretch" | "migrated" | "trending";

/** One Discover row: a tradeable pair plus the context a trader screens on. */
export type FeedItem = {
  pair: Pair;
  windows: Record<Window, WindowStats>;
  socials: { twitter: string | null; telegram: string | null; website: string | null };
  /** Paid DexScreener profile. */
  dexPaid: boolean;
  boosts: number;
  /** pump.fun-only fields (null for other launchpads). */
  replies: number | null;
  athMarketCapUsd: number | null;
  live: boolean;
  /** 0–1 bonding-curve progress; null once graduated or not a pump.fun coin. */
  curveProgress: number | null;
  createdAt: number | null;
};
