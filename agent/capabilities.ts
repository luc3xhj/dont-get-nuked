// Data capability registry (V2 WP13). Every external route is registered with its access scope, cost
// status, evidence stage and measured behavior. A route's existence in code proves nothing: a strategy
// may only rely on a route that is enabled, verified zero-cost and live-checked for the fields it needs.
// Unknown or paid routes are denied before any network request is made.
import { db } from "./db";
import { httpStats } from "./http";

export type EvidenceStage = "documented" | "fixture_checked" | "live_checked";
export type ZeroCost = "verified_free" | "documented_free" | "unknown" | "paid";
export type CapabilityState = "qualified" | "degraded" | "unsupported";

export type Route = {
  id: string;
  provider: string;
  operation: string;
  host: string | null;
  accessScope: string;
  zeroCost: ZeroCost;
  /** Highest evidence stage reached (live_checked only from a recorded diagnostic or continuous use). */
  stage: EvidenceStage;
  enabled: boolean;
  /** Why it's disabled or limited, in words. */
  note: string;
  /** Needs a credential name from private config (never the secret itself). */
  credentialEnv?: string;
  timestampSemantics: string;
};

const hasEnv = (k: string) => !!process.env[k];

/** The registered routes. Disabled routes perform no network work. */
export function routes(): Route[] {
  return [
    {
      id: "pump.lists",
      provider: "pump.fun",
      operation: "coin lists (new, last trade, market cap, graduated)",
      host: "frontend-api-v3.pump.fun",
      accessScope: "public keyless lists, 100 rows per call",
      zeroCost: "verified_free",
      stage: "live_checked",
      enabled: true,
      note: "Bounded result sets: discovery is sampled every 10s, never a complete market list.",
      timestampSemantics: "created_timestamp from pump.fun; list snapshot time = receivedAt",
    },
    {
      id: "pump.trades",
      provider: "pump.fun",
      operation: "trade pages (launch backfill)",
      host: "swap-api.pump.fun",
      accessScope: "public keyless, ~20 req/min before 429",
      zeroCost: "verified_free",
      stage: "live_checked",
      enabled: true,
      note: "Backfill of new coins only (≤ 4 pages).",
      timestampSemantics: "chain block time per trade; receivedAt recorded",
    },
    {
      id: "gecko.trades",
      provider: "GeckoTerminal",
      operation: "latest 300 pool trades",
      host: "api.geckoterminal.com",
      accessScope: "public keyless, app cap 10 req/min",
      zeroCost: "verified_free",
      stage: "live_checked",
      enabled: true,
      note: "Shared by all deep-watched coins and the chart; one sweep of 14 coins takes ~84s at the cap.",
      timestampSemantics: "block timestamp per trade; receivedAt recorded",
    },
    {
      id: "dexscreener.pairs",
      provider: "DEX Screener",
      operation: "pair snapshots (price, reserves, volume, txns), 30 per call",
      host: "api.dexscreener.com",
      accessScope: "public keyless",
      zeroCost: "verified_free",
      stage: "live_checked",
      enabled: true,
      note: "Indicative snapshots, not a swap tape or a size-specific executable quote.",
      timestampSemantics: "no provider observation time; receivedAt only",
    },
    {
      id: "rugcheck.report",
      provider: "RugCheck",
      operation: "token report (holders, insiders, authorities, LP)",
      host: "api.rugcheck.xyz",
      accessScope: "public keyless, app cap 20 req/min",
      zeroCost: "verified_free",
      stage: "live_checked",
      enabled: true,
      note: "Holder data at report time.",
      timestampSemantics: "report receivedAt",
    },
    {
      id: "fxtwitter.post",
      provider: "FxTwitter",
      operation: "single linked post or profile",
      host: "api.fxtwitter.com",
      accessScope: "one linked post/profile; not platform monitoring",
      zeroCost: "verified_free",
      stage: "live_checked",
      enabled: true,
      note: "X Communities and channels are not readable on this route.",
      timestampSemantics: "post created_at when supplied",
    },
    {
      id: "solana.public_rpc",
      provider: "Solana Foundation",
      operation: "getSignaturesForAddress / getTransaction",
      host: "api.mainnet-beta.solana.com",
      accessScope: "public RPC, heavily rate-limited",
      zeroCost: "verified_free",
      stage: "live_checked",
      enabled: !hasEnv("HELIUS_API_KEY"),
      note: "Used for top-holder funding when no Helius key is configured.",
      timestampSemantics: "block time",
    },
    {
      id: "helius.rpc",
      provider: "Helius",
      operation: "RPC (free tier)",
      host: "mainnet.helius-rpc.com",
      accessScope: "free developer key",
      zeroCost: hasEnv("HELIUS_API_KEY") ? "documented_free" : "unknown",
      stage: "documented",
      enabled: hasEnv("HELIUS_API_KEY"),
      credentialEnv: "HELIUS_API_KEY",
      note: hasEnv("HELIUS_API_KEY") ? "Configured; free-tier credits." : "No key configured.",
      timestampSemantics: "block time",
    },
    {
      id: "helius.standard_ws",
      provider: "Helius",
      operation: "standard WebSocket (logsSubscribe)",
      host: null,
      accessScope: "free developer key",
      zeroCost: "documented_free",
      stage: "documented",
      enabled: false,
      credentialEnv: "HELIUS_API_KEY",
      note: "Would give a real-time tape for watched pools; needs a free key plus parsing and gap recovery. Not implemented yet.",
      timestampSemantics: "slot; block time after confirmation",
    },
    {
      id: "pumpportal.new_token",
      provider: "PumpPortal",
      operation: "subscribeNewToken",
      host: "pumpportal.fun",
      accessScope: "public data socket, keyless; one connection",
      zeroCost: "verified_free",
      stage: "live_checked",
      enabled: true,
      note: "Free per PumpPortal docs; live diagnostic received create events without a key.",
      timestampSemantics: "no event time in the message; receivedAt only",
    },
    {
      id: "pumpportal.migration",
      provider: "PumpPortal",
      operation: "subscribeMigration",
      host: "pumpportal.fun",
      accessScope: "public data socket, keyless; one connection",
      zeroCost: "verified_free",
      stage: "fixture_checked",
      enabled: true,
      note: "Free per PumpPortal docs; promoted to live-checked once a migration event is received.",
      timestampSemantics: "no event time in the message; receivedAt only",
    },
    {
      id: "pumpportal.token_trade",
      provider: "PumpPortal",
      operation: "subscribeTokenTrade / subscribeAccountTrade",
      host: "pumpportal.fun",
      accessScope: "API key + funded wallet",
      zeroCost: "paid",
      stage: "documented",
      enabled: false,
      note: "Metered (0.01 SOL per 10k events): denied under the free-only policy.",
      timestampSemantics: "n/a",
    },
    {
      id: "jupiter.quote",
      provider: "Jupiter",
      operation: "read-only quote (no taker)",
      host: null,
      accessScope: "unverified",
      zeroCost: "unknown",
      stage: "documented",
      enabled: false,
      note: "Zero-cost entitlement not verified: execution uses the named local AMM model instead.",
      timestampSemantics: "quote context slot",
    },
    {
      id: "treg.search",
      provider: "Treg (tinyfish.web.search)",
      operation: "web search, $0 catalog price, zero-cost headers on every call",
      host: null,
      accessScope: "private token in .env.local",
      zeroCost: "verified_free",
      stage: "live_checked",
      enabled: hasEnv("TREG_TOKEN"),
      credentialEnv: "TREG_TOKEN",
      note: hasEnv("TREG_TOKEN") ? "Price checked before each call; paid fallback disabled." : "No token configured.",
      timestampSemantics: "search retrieval time; publication time when the result supplies it",
    },
  ];
}

/** Hosts that must never be called (paid or unverified routes). Checked by the HTTP layer before dispatch. */
export const DENIED_OPERATIONS = new Set(["subscribeTokenTrade", "subscribeAccountTrade"]);

// ---------- live stream measurements, registered by the stream adapters ----------

type StreamStats = Record<string, { events: number; lastEventAt: number | null; connected: boolean; reconnects: number; gapMs: number }>;
let streamStats: () => StreamStats = () => ({});
export const registerStreamStats = (fn: () => StreamStats) => {
  streamStats = fn;
};

db.exec(
  "CREATE TABLE IF NOT EXISTS capability_results (route TEXT NOT NULL, at INTEGER NOT NULL, stage TEXT NOT NULL, detail TEXT NOT NULL, PRIMARY KEY (route, at)) WITHOUT ROWID",
);
/** Persists a diagnostic or stage change (e.g. the first live migration event). */
export function recordCapabilityResult(route: string, stage: EvidenceStage, detail: Record<string, unknown>) {
  db.prepare("INSERT OR REPLACE INTO capability_results (route, at, stage, detail) VALUES (?, ?, ?, ?)").run(route, Date.now(), stage, JSON.stringify(detail));
}
const reachedLive = (route: string) => !!db.prepare("SELECT 1 FROM capability_results WHERE route = ? AND stage = 'live_checked'").get(route);

/** Registry with current measurements and the stage each route has actually reached. */
export function capabilityReport() {
  const http = httpStats();
  const streams = streamStats();
  return routes().map((r) => {
    const h = r.host ? http[r.host] : undefined;
    const st = streams[r.id];
    const stage: EvidenceStage = r.stage === "live_checked" || reachedLive(r.id) ? "live_checked" : r.stage;
    const failing = h ? h.errors > 5 && h.errors > h.ok : false;
    const state: CapabilityState =
      !r.enabled || r.zeroCost === "paid" || r.zeroCost === "unknown"
        ? "unsupported"
        : stage !== "live_checked"
          ? "unsupported"
          : failing || (st && !st.connected)
            ? "degraded"
            : "qualified";
    return {
      ...r,
      stage,
      state,
      measured: {
        ...(h ? { ok: h.ok, errors: h.errors, queued: h.queued, pausedForMs: h.pausedForMs, waitP95Ms: h.waitP95Ms, lastError: h.lastError } : {}),
        ...(st ?? {}),
      },
    };
  });
}

export const capabilityState = (id: string) => capabilityReport().find((r) => r.id === id)?.state ?? "unsupported";
