// Client-side shapes of the agent worker's API (agent/*), and display helpers shared by pages.
// Kept loose on purpose: the web app only renders what the worker reports.

export type Flow = {
  buySol: number;
  sellSol: number;
  netSol: number;
  buys: number;
  sells: number;
  buyers: number;
  sellers: number;
  newBuyerShare: number;
  medianBuySol: number;
  maxBuySol: number;
  roundTripShare: number;
};
export type Cohort = { wallets: number; heldPct: number; soldFraction: number; sellSol60s: number };
export type Features = {
  ageMin: number;
  priceSol: number;
  mcapSol: number;
  athMcapSol: number;
  drawdown: number;
  minSinceAth: number;
  bounceFromLow: number;
  higherLow: boolean;
  flow15s: Flow;
  flow60s: Flow;
  flow5m: Flow;
  cohorts: { dev: Cohort; snipers: Cohort; bundles: Cohort; early: Cohort; insiders: Cohort };
  exhaustion: number | null;
  exhaustionBasis: "cohorts" | "all-sellers";
  liquidityUsd: number | null;
  repeatBuyShare: number;
  tapeTrades: number;
  tapeFromLaunch: boolean;
  observedMin?: number;
  /** "observed" when the tape doesn't reach launch: the ATH shown is the highest we saw, not the true ATH. */
  highScope?: "launch" | "observed";
  tapeGaps?: number;
  cohortsReliable?: boolean;
  migratedAgeMin?: number | null;
};
export type ScreenLevel = "veto" | "warn" | "ok" | "unknown";
export type EvidenceStatus = "verified" | "adverse" | "unknown" | "stale";
export type Screen = { id: string; label: string; level: ScreenLevel; detail: string; status?: EvidenceStatus; observedAt?: number | null };
export type Check = { label: string; ok: boolean; value: string };
export type SetupEpisode = { id: string; state: "armed" | "fired" | "cooldown"; armedAt: number; firedAt: number | null; cooldownUntil?: number };
export type SetupEval = { setup: string; status: "armed" | "fire"; structure: Check[]; trigger: Check[]; quality: number; episode?: SetupEpisode };
export type Analysis = {
  at: number;
  expiresAt: number;
  verdict: "approve" | "neutral" | "reject";
  conviction: number;
  narrativeType: string;
  narrative: string;
  contractVerified: "yes" | "no" | "unknown";
  copycat: boolean;
  redFlags: string[];
  greenFlags: string[];
  thesis: string;
  wouldChangeMind: string;
  sources: string[];
};
export type Quote = { at: number; priceSol: number; priceUsd: number; liquidityUsd: number; mcapUsd: number };
export type Social = {
  kind: string;
  text: string | null;
  likes: number | null;
  views: number | null;
  author: string | null;
  authorFollowers: number | null;
} | null;

export type WatchedCoin = {
  mint: string;
  symbol: string;
  name: string;
  stage: "curve" | "migrated";
  lane: "new" | "stretch" | "migrated" | null;
  createdAt: number;
  socials: { twitter: string | null; telegram: string | null; website: string | null };
  score: number | null;
  verdict: ScreenLevel;
  screens: Screen[];
  features: Features | null;
  setups: SetupEval[];
  analysis: Analysis | null;
  held: boolean;
  pairAddress: string;
  quote: Quote | null;
  curveProgress: number | null;
  social: Social;
  dev?: {
    launches: number;
    capped: boolean;
    launches24h: number;
    graduated: number;
    resolved?: number;
    successes: number;
    successRate: number;
    successLowerBound?: number;
    bestAthUsd: number;
    died: number;
  } | null;
  funding?: { checked: number; fresh: number; freshPct: number; clusters: { funder: string; wallets: string[]; pct: number }[]; topClusterPct: number; exchangeFunded: number; payerOnly?: number; unresolvedPct?: number } | null;
};

export type AgentState = {
  now: number;
  startedAt: number;
  stats: { tracked: number; hot: number; tapePolls: number; tapeErrors: number; tradesIngested: number };
  http: Record<string, { ok: number; errors: number; pausedForMs: number; lastError: string | null }>;
  analyst: { provider: "codex"; status: string; lastError: string | null; callsLastHour: number; maxPerHour: number; model: string; running: string | null };
  treg: { configured: boolean; calls: number; failures: number; disabled: string | null; lastError: string | null; lastCallId: string | null; lastCostMicro: number | null; lastSuccessAt: number | null; lastResultCount: number | null };
  regime: Regime;
  hot: WatchedCoin[];
};

export type Regime = {
  level: "good" | "caution" | "bad";
  reasons: string[];
  solUsd: number | null;
  solChange1h: number | null;
  graduations2h: number | null;
  launches1h: number;
  benchmarkAvgR: number | null;
  benchmarkTrades: number;
};

export const REGIME_TONE: Record<Regime["level"], string> = {
  good: "border-emerald-900 bg-emerald-500/5 text-emerald-300",
  caution: "border-amber-900 bg-amber-500/10 text-amber-300",
  bad: "border-rose-900 bg-rose-500/10 text-rose-300",
};

export type DatasetSummary = { captured: number; labeled: number; rugs: number; graduated: number; sampled: number; rugRate: number | null };

export type Fill = { ts: number; side: "buy" | "sell"; sol: number; priceSol: number; reason?: string };
export type TapeTrade = { id: string; ts: number; wallet: string; side: "buy" | "sell"; sol: number; priceSol: number };
export type CoinDetail =
  | (WatchedCoin & {
      tracked: true;
      fills: Fill[];
      recentTrades: TapeTrade[];
      traders?: TraderOnCoin[];
      holdersReport: { top: { owner: string; pct: number; insider: boolean }[]; totalHolders: number | null } | null;
    })
  | {
      tracked: false;
      mint: string;
      symbol: string | null;
      name: string | null;
      stage: string | null;
      pairAddress: string | null;
      socials: WatchedCoin["socials"] | null;
      fills: Fill[];
    };

export type Stats = {
  trades: number;
  winRate: number;
  pnlSol: number;
  returnOnCost: number;
  avgR: number;
  expectancySol: number;
  bestShare: number | null;
};
export type AccountId = "agent" | "shadow" | "baseline";
export type Account = {
  id: AccountId;
  cash: number;
  positions: number;
  equity: number;
  unpriced: number;
  startCash: number;
  paused: string | null;
  cooldownUntil: number;
  lossStreak: number;
  stats: Stats;
  bySetup: Record<string, Stats>;
  byAnalyst: Record<string, Stats>;
  curve: [number, number][];
};
export type Plan = { entrySol: number; stopSol: number; tp1Sol: number; tp2Sol: number; maxHoldMin: number };
export type OpenPosition = {
  id: string;
  account: AccountId;
  mint: string;
  symbol: string;
  setup: string;
  openedAt: number;
  entryPriceSol: number;
  costSol: number;
  proceedsSol: number;
  plan: Plan;
  stopSol: number;
  tp1Done: boolean;
  priceSol: number | null;
  unrealizedSol: number | null;
  heldMin: number;
  evidence: string[];
  analystAtEntry: string;
};
export type ClosedTrade = {
  id: string;
  account: AccountId;
  mint: string;
  symbol: string;
  setup: string;
  openedAt: number;
  closedAt: number;
  costSol: number;
  pnlSol: number;
  pnlPct: number;
  r: number;
  exitReason: string;
  holdMin: number;
  analystAtEntry: string;
};
export type Decision = {
  at: number;
  mint: string;
  symbol: string;
  setup: string;
  take: boolean;
  sizeSol: number;
  ev: number;
  p: number;
  mode: "explore" | "evidence";
  n: number;
  analyst: { verdict: string; conviction: number; note: string };
  regime?: { level: string; reasons: string[] };
  reasons: string[];
  version?: string;
  /** Net economics at the exact size taken (null on a pass). */
  costs?: { sizeSol: number; entryImpact: number; tp1NetSol: number; stopNetSol: number; netRewardRisk: number; roundTripCostPct: number } | null;
  essentials?: { id: string; label: string; ok: boolean; detail: string }[];
};
export type PortfolioReport = {
  accounts: Account[];
  open: OpenPosition[];
  pending: { account: AccountId; mint: string; side: string; reason: string; ageMs: number; waiting?: boolean }[];
  closed: ClosedTrade[];
  decisions: Decision[];
  strategyVersion?: string;
  evidenceVersions?: string[];
  researchCoverage?: { version: string; decisions: number; withValidReport: number; share: number; medianAgeMin: number | null };
};

export type ActivityItem = {
  seq: number;
  ts: number;
  mint: string | null;
  symbol: string | null;
  tone: "buy" | "sell" | "win" | "loss" | "setup" | "pass" | "analyst" | "system" | "trader";
  title: string;
  detail: string;
};

export const SETUP_LABEL: Record<string, string> = {
  new_dump: "New pair · first dump",
  stretch_deep: "Final Stretch · deep selloff",
  stretch_pullback: "Final Stretch · pullback",
  dev_base: "Proven dev · base",
  migrated_base: "Migrated · bleed then base",
  random: "Random control",
};

export const LANE_LABEL = { new: "New", stretch: "Final Stretch", migrated: "Migrated" } as const;
export const LANE_TONE = { new: "text-emerald-400", stretch: "text-violet-300", migrated: "text-sky-300" } as const;

export const SCREEN_TONE: Record<ScreenLevel, string> = {
  veto: "bg-rose-500/15 text-rose-300 border-rose-900",
  warn: "bg-amber-500/10 text-amber-300 border-amber-900",
  ok: "bg-emerald-500/10 text-emerald-300 border-emerald-900",
  unknown: "bg-zinc-800 text-zinc-400 border-zinc-700",
};

export const VERDICT_TONE: Record<Analysis["verdict"], string> = {
  approve: "border-emerald-800 bg-emerald-500/10 text-emerald-300",
  neutral: "border-zinc-700 bg-zinc-800 text-zinc-300",
  reject: "border-rose-900 bg-rose-500/15 text-rose-300",
};

/** pump.fun's thumbnail CDN, keyed by mint. */
export const coinImage = (mint: string) => `https://images.pump.fun/coin-image/${mint}?variant=86x86`;

export const solSigned = (v: number, d = 3) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}◎`;
export const pctSigned = (v: number, d = 0) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;

/** A watched or discovered wallet's position in one coin, computed from the tape. */
export type TraderOnCoin = {
  address: string;
  name: string | null;
  xHandle: string | null;
  source: "watching" | "discovered";
  firstBuyAt: number;
  entryMcapUsd: number | null;
  multiple: number | null;
  holdingPct: number;
  solIn: number;
  solOut: number;
  pnlSol: number | null;
  lastAction: "buy" | "sell";
  lastActionAt: number;
  complete: boolean;
  actions: { ts: number; side: "buy" | "sell"; sol: number }[];
};

export type DiscoveredWallet = {
  address: string;
  closed: number;
  wins: number;
  winRateLower: number;
  realizedSol: number;
  returnOnCost?: number;
  avgHoldMin?: number;
  coins: number;
  lastActiveAt: number;
  score: number;
};

export type TradersReport = {
  discovery: { minClosed: number; ranked: number; top: number };
  watching: {
    address: string;
    name: string;
    xHandle: string | null;
    note: string;
    addedAt: number;
    coinsSeen: number;
    lastActiveAt: number | null;
    lastMint: string | null;
    discovered: DiscoveredWallet | null;
  }[];
  discovered: (DiscoveredWallet & { watching: boolean })[];
};

export const shortAddr = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

// ---------- Pulse (Axiom-style coin list) ----------

export type PulseRange = { min: number | null; max: number | null };
export type PulseRangeKey =
  | "age"
  | "top10Holders"
  | "devHolding"
  | "snipers"
  | "insiders"
  | "bundle"
  | "holders"
  | "bondingCurve"
  | "liquidity"
  | "volume"
  | "marketCap"
  | "txns"
  | "numBuys"
  | "numSells";
export type PulseFlagKey = "twitter" | "website" | "telegram" | "dexPaid" | "anySocial";
export type PulseFilters = Record<PulseRangeKey, PulseRange> & Record<PulseFlagKey, boolean> & { searchKeywords: string[]; excludeKeywords: string[] };
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
export type PulseColumnId = "newPairs" | "finalStretch" | "migrated";
export type PulseCoin = {
  mint: string;
  symbol: string;
  name: string;
  createdAt: number;
  hot: boolean;
  status: "pass" | "checking";
  failed: string[];
  unknown: string[];
  metrics: PulseMetrics;
};
export type PulseColumn = {
  id: PulseColumnId;
  label: string;
  filters: PulseFilters;
  preset: PulseFilters;
  counts: { seen: number; pass: number; checking: number; fail: number };
  failReasons: Record<string, number>;
  coins: PulseCoin[];
};
export type PulseReport = { at: number; note: string; labels: Record<string, string>; columns: PulseColumn[] };
