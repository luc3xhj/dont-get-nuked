export type Stage = "curve" | "migrated";

export type Socials = { twitter: string | null; telegram: string | null; website: string | null };

/** A pump.fun coin as the agent tracks it. Prices are in SOL (SOL-denominated thresholds survive SOL moves). */
export type Coin = {
  mint: string;
  symbol: string;
  name: string;
  creator: string;
  curve: string;
  pool: string | null;
  stage: Stage;
  createdAt: number;
  socials: Socials;
  replies: number;
  mcapUsd: number;
  athMcapUsd: number | null;
  /** 0–1 while on the curve. */
  curveProgress: number | null;
  lastTradeAt: number;
  firstSeen: number;
  updatedAt: number;
};

export type Trade = {
  /** Sort key: zero-padded slot first, so ids order by time across sources. */
  id: string;
  /** Transaction signature; dedupes the same trade seen by both tape sources. */
  tx: string;
  mint: string;
  ts: number;
  slot: number;
  wallet: string;
  side: "buy" | "sell";
  sol: number;
  tokens: number;
  priceSol: number;
  program: string;
};

/** Fast price snapshot (DexScreener), refreshed every ~2 s between tape polls. */
export type Quote = { at: number; priceSol: number; priceUsd: number; liquidityUsd: number; mcapUsd: number };

export type Holder = { owner: string; pct: number; insider: boolean };

export type HolderReport = {
  at: number;
  totalHolders: number | null;
  /** Top holders excluding the curve / pool / known program accounts. */
  top: Holder[];
  top10ExPoolPct: number;
  insidersDetected: number;
  creatorPct: number | null;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  risks: string[];
};

export type SocialReport = {
  at: number;
  kind: "tweet" | "profile" | "community" | "other" | "none";
  url: string | null;
  text: string | null;
  likes: number | null;
  views: number | null;
  postedAt: number | null;
  author: string | null;
  authorFollowers: number | null;
  authorJoinedAt: number | null;
  mentionsMint: boolean | null;
  error: string | null;
};

export type Flow = {
  buySol: number;
  sellSol: number;
  netSol: number;
  buys: number;
  sells: number;
  buyers: number;
  sellers: number;
  /** Buyers seen for the first time in this window. */
  newBuyerShare: number;
  medianBuySol: number;
  maxBuySol: number;
  /** Share of volume from wallets that both bought and sold in the window. */
  roundTripShare: number;
};

export type Cohort = {
  wallets: number;
  /** Percent of total supply the cohort still holds according to the tape. */
  heldPct: number;
  /** Fraction of what the cohort bought that it has sold. */
  soldFraction: number;
  sellSol60s: number;
};

export type Features = {
  at: number;
  ageMin: number;
  stage: Stage;
  priceSol: number;
  mcapSol: number;
  athMcapSol: number;
  drawdown: number;
  minSinceAth: number;
  /** Bounce off the lowest price since the ATH. */
  bounceFromLow: number;
  range10m: number;
  higherLow: boolean;
  curveProgress: number | null;
  flow15s: Flow;
  flow60s: Flow;
  flow5m: Flow;
  cohorts: { dev: Cohort; snipers: Cohort; bundles: Cohort; early: Cohort };
  /** 0–1: selling has slowed while price stopped making new lows (launch cohorts when known, else all sellers). */
  exhaustion: number | null;
  exhaustionBasis: "cohorts" | "all-sellers";
  /** Pool liquidity in USD (migrated coins; 0 on the curve). */
  liquidityUsd: number | null;
  tapeTrades: number;
  tapeFromLaunch: boolean;
};

export type ScreenLevel = "veto" | "warn" | "ok" | "unknown";
export type ScreenResult = { id: string; label: string; level: ScreenLevel; detail: string };
