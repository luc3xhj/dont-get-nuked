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
