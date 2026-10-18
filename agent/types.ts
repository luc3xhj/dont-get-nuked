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
export type Quote = {
  at: number;
  priceSol: number;
  priceUsd: number;
  liquidityUsd: number;
  mcapUsd: number;
  /** Pool reserves (PumpSwap); 0 on the curve, where reserves follow from the price. */
  reserveTokens: number;
  reserveSol: number;
};

export type Holder = { owner: string; pct: number; insider: boolean };

export type HolderReport = {
  at: number;
  totalHolders: number | null;
  /** Top holders excluding the curve / pool / known program accounts. */
  top: Holder[];
  top10ExPoolPct: number;
  insidersDetected: number;
  /** % of supply still held by RugCheck's linked insider networks. */
  insiderPct?: number;
  creatorPct: number | null;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** Metadata can be changed after launch (name, image, links). */
  metadataMutable: boolean | null;
  /** LP locked/burned % in the deepest pool (migrated coins); null on the curve. */
  lpLockedPct: number | null;
  rugged: boolean;
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

export type VolumeQuality = {
  trades: number;
  traders: number;
  tradesPerTrader: number;
  avgTradeSol: number;
  /** Wallets that both bought and sold. */
  twoSidedShare: number;
  /** Mean min(buy, sell) / max(buy, sell) across the 10 biggest wallets; ~1 means pure round trips. */
  roundTripTop10: number;
  top5VolShare: number;
  top10VolShare: number;
  /** 0–1 composite; null when there are too few trades to judge. */
  washScore: number | null;
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
  /** Lowest price since the ATH, and how long ago it printed. */
  lowSol: number;
  lowAgeMin: number;
  /** Deepest drawdown from the ATH (at the low). */
  maxDrawdown: number;
  /** Minutes the price has held within 30% above the post-ATH low. */
  baseMin: number;
  range10m: number;
  hi10Sol: number;
  lo10Sol: number;
  /** Largest net seller since the ATH, as % of supply, and whether they sold in the last minute. */
  topSellerPct: number;
  topSellerActive: boolean;
  /** Share of 5m buys that repeat the same wallet + size (bump/volume bots). */
  repeatBuyShare: number;
  /** Volume quality over 5 minutes (wash / bot detection, Bitquery-style). */
  volume: VolumeQuality;
  /** Bonding-curve progress per minute of age; fast fills often mean coordinated buying. */
  curveFillPerMin: number | null;
  /** Share of all buy SOL since launch that came from the 10 biggest buyers (needs launch tape). */
  launchBuyConcentration: number | null;
  higherLow: boolean;
  curveProgress: number | null;
  flow15s: Flow;
  flow60s: Flow;
  flow5m: Flow;
  /** insiders = dev + snipers + bundles combined. */
  cohorts: { dev: Cohort; snipers: Cohort; bundles: Cohort; early: Cohort; insiders: Cohort };
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

/** A creator's launch history on pump.fun (excluding the coin being judged). */
export type DevReport = {
  at: number;
  /** Launches found (the lookup returns at most 50, so `capped` means "50 or more"). */
  launches: number;
  capped: boolean;
  launches24h: number;
  graduated: number;
  /** Graduated, or reached a $100k ATH. */
  successes: number;
  successRate: number;
  bestAthUsd: number;
  medianAthUsd: number;
  /** Older than an hour and never passed a $10k ATH. */
  died: number;
};

/** Top-holder wallet ages and funding sources. */
export type FundingReport = {
  at: number;
  checked: number;
  /** Wallets under a day old (or with almost no history). */
  fresh: number;
  freshPct: number;
  /** Top holders that share a (non-exchange) first funder. */
  clusters: { funder: string; wallets: string[]; pct: number }[];
  topClusterPct: number;
  exchangeFunded: number;
  unknownFunder: number;
  provider: "helius" | "public";
};
