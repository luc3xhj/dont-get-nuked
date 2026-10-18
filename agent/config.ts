// Agent worker configuration. Thresholds are starting priors from research and the
// Setuh study notes (docs/trading-agent-design.md); calibrate them from the journal.

export const CONFIG = {
  /**
   * Bump when strategy, screen, cost or execution semantics change. Trades and decisions are tagged
   * with it, and the agent only learns from benchmark trades of the versions listed below.
   */
  strategyVersion: "2026-10-18.2",
  /** Benchmark (shadow) trades from these versions inform sizing/edge decisions. Explicit, never implicit. */
  evidenceVersions: ["2026-10-18.2"] as string[],

  /** Decision-time evidence and cost requirements (roadmap Stage A). */
  decision: {
    /** Net reward at TP1 divided by net loss at the stop (both after fees, impact and stop gap). */
    minNetRewardRisk: 1.0,
    /** Older than this, a report is "stale" and can't satisfy an essential requirement. */
    holderReportMaxAgeMs: 15 * 60_000,
    socialMaxAgeMs: 60 * 60_000,
    fundingMaxAgeMs: 2 * 3600_000,
    devMaxAgeMs: 6 * 3600_000,
    sizingIterations: 4,
  },

  /** Setup episodes: an armed setup that doesn't fire in time, or breaks its structure, is retired. */
  setupEpisode: { maxArmedMs: 20 * 60_000, cooldownMs: 30 * 60_000 },

  /** Developer quality: only prior launches old enough to have an outcome count. */
  developer: { resolveAfterMs: 6 * 3600_000, minResolved: 3, minSuccessLowerBound: 0.15 },

  port: Number(process.env.AGENT_PORT ?? 3101),
  dbPath: process.env.AGENT_DB ?? "agent/data/agent.sqlite",

  universe: {
    /** How often to refresh the pump.fun coin lists. */
    refreshMs: 10_000,
    /** Coins under deep watch (full trade tape + holders + socials). */
    hotSlots: 14,
    /** Deep-watch slots reserved per discovery pool (new pairs / final stretch / migrated). */
    laneSlots: { new: 5, stretch: 4, migrated: 5 },
    /** Keep a coin hot at least this long once promoted, to avoid churn. */
    minHotMs: 3 * 60_000,
    /** Drop from hot if no trade for this long. */
    idleMs: 3 * 60_000,
    maxAgeMs: 6 * 3600_000,
  },

  tape: {
    /**
     * Poll each hot coin often enough that a 100-trade page never misses trades, within
     * these bounds. pump.fun's trade API allows ~60 req/min per IP; we budget 40 (http.ts).
     */
    minPollMs: 4_000,
    maxPollMs: 30_000,
    /** Held and armed coins are polled at least this often. */
    priorityPollMs: 10_000,
    pageSize: 100,
    /** Backfill cap (pages) when a coin first becomes hot. Migrated coins skip backfill. */
    maxBackfillPages: 4,
    /** Concurrent requests to pump.fun's trade API. */
    concurrency: 3,
  },

  holders: { refreshMs: 3 * 60_000, concurrency: 2 },
  socials: { refreshMs: 10 * 60_000, concurrency: 2 },

  cohorts: {
    /** Buys within this many slots of the first trade count as snipers. */
    sniperSlots: 2,
    /** A slot in the launch window with >= this many distinct buyers marks them as a bundle. */
    bundleMinWallets: 3,
    bundleWindowSlots: 10,
    earlyBuyers: 20,
  },

  /** Screen thresholds (percent of total supply unless noted). */
  screens: {
    top10ExPoolVetoPct: 35,
    top10ExPoolWarnPct: 25,
    bundleHeldVetoPct: 15,
    bundleHeldWarnPct: 7,
    sniperHeldWarnPct: 15,
    devHeldWarnPct: 8,
    /** Veto when holders RugCheck links as insiders control at least this much supply. */
    insiderVetoPct: 10,
    /** A creator launching this many coins a day is spraying launches, not building one. */
    serialLaunches24h: 10,
    /** Top holders sharing a non-exchange funder: likely one entity. */
    fundingClusterWarnPct: 5,
    fundingClusterVetoPct: 10,
    freshWalletPct: 10,
    washWarn: 0.45,
    /** A call from an account this large is a chase risk (big-account calls did worst). */
    bigAccountFollowers: 200_000,
    washVeto: 0.7,
  },

  totalSupply: 1_000_000_000,
};
