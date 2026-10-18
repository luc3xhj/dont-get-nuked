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
};
export type ScreenLevel = "veto" | "warn" | "ok" | "unknown";
export type Screen = { id: string; label: string; level: ScreenLevel; detail: string };
export type Check = { label: string; ok: boolean; value: string };
export type SetupEval = { setup: string; status: "armed" | "fire"; structure: Check[]; trigger: Check[]; quality: number };
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
};

export type AgentState = {
  now: number;
  startedAt: number;
  stats: { tracked: number; hot: number; tapePolls: number; tapeErrors: number; tradesIngested: number };
  http: Record<string, { ok: number; errors: number; pausedForMs: number; lastError: string | null }>;
  analyst: { status: string; lastError: string | null; callsLastHour: number; maxPerHour: number; model: string; running: string | null };
  treg: { configured: boolean; calls: number; failures: number; disabled: string | null; lastError: string | null };
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
};
export type PortfolioReport = {
  accounts: Account[];
  open: OpenPosition[];
  pending: { account: AccountId; mint: string; side: string; reason: string; ageMs: number }[];
  closed: ClosedTrade[];
  decisions: Decision[];
};

export type ActivityItem = {
  seq: number;
  ts: number;
  mint: string | null;
  symbol: string | null;
  tone: "buy" | "sell" | "win" | "loss" | "setup" | "pass" | "analyst" | "system";
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
