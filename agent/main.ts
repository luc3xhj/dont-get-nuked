// Agent worker: runs continuously, independent of the browser.
//   npm run agent
// Watches live pump.fun coins, detects setups, consults the analyst, and paper-trades one wallet
// (plus two background benchmarks), exposing everything through a local JSON API.
import { createServer } from "node:http";
import { activity, agentFills, storedCoin } from "./activity";
import { CONFIG } from "./config";
import { journal, prune } from "./db";
import { computeFeatures } from "./features";
import { httpStats } from "./http";
import { runScreens, verdict } from "./screens";
import { ANALYST, analystHealth, analystTick } from "./analyst";
import { captureHot, datasetCsv, datasetSummary, labelTick, sampleTick } from "./dataset";
import { regime, regimeTick } from "./regime";
import { walletsTick } from "./wallets";
import { evidenceReport } from "./evidence";
import { tregHealth } from "./research";
import { researchReport } from "./research-report";
import {
  cancelPendingBuys,
  control,
  heldMints,
  obligationMints,
  onSignals,
  portfolioReport,
  portfolioTick,
  reconciliationReport,
  restorePortfolio,
  walletSummary,
} from "./portfolio";
import { commandStatus, executeCommand, stateRevision } from "./commands";
import { appliedVersions, runMigrations } from "./migrations";
import { MIGRATIONS } from "./schema";
import { capabilityReport } from "./capabilities";
import { jobsReport, recoverJobs } from "./jobs";
import { startLifecycleStream, stopLifecycleStream } from "./streams";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { restoreEpisodes, trackEpisodes } from "./episodes";
import { evaluateSetups } from "./setups";
import { funnelReport, markVersionStart } from "./funnel";
import { COLUMNS, evaluatePulse, pulseReport, pulseTick, setFilters, type ColumnId } from "./pulse";
import { discoverTraders, onTrades, tradersOnCoin, tradersReport, unwatchWallet, watchWallet } from "./traders";
import {
  coins,
  devHistory,
  laneOf,
  pairAddress,
  pinned,
  quoteTick,
  refreshUniverse,
  reportsTick,
  restore,
  stats,
  ensureCoins,
  tapeCoverage,
  tapeTick,
  tradeListeners,
  type CoinState,
} from "./state";

const lastArmed = new Map<string, number>();

function evaluate(s: CoinState) {
  s.features = computeFeatures(s);
  s.screens = runScreens(s);
  // Snipers and bundles become measurable once the launch tape is in.
  evaluatePulse(s);
  s.setups = evaluateSetups(s, devHistory(s));
  // Note when a setup first arms (once per coin+setup per 10 minutes) for the activity feed.
  for (const x of s.setups) {
    const key = `${s.coin.mint}:${x.setup}`;
    if (x.status === "armed" && Date.now() - (lastArmed.get(key) ?? 0) > 10 * 60_000) {
      lastArmed.set(key, Date.now());
      journal("armed", s.coin.mint, { setup: x.setup, passed: x.trigger.filter((k) => k.ok).length, total: x.trigger.length });
    }
  }
  captureHot(s);
  // Only fires from a live episode count; an expired or invalidated one cools down first.
  const fired = trackEpisodes(s.coin.mint, s.setups);
  // New entries only while the worker is healthy (not recovering, faulted or draining).
  if (fired.length && workerState === "running") onSignals(s, fired);
}

function loop(name: string, everyMs: number, fn: () => Promise<void>) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (e) {
      console.error(`[${name}]`, e instanceof Error ? e.message : e);
    } finally {
      running = false;
    }
  };
  tick();
  setInterval(tick, everyMs);
}

// ---------- API ----------

function summary(s: CoinState) {
  const f = s.features;
  return {
    mint: s.coin.mint,
    symbol: s.coin.symbol,
    name: s.coin.name,
    stage: s.coin.stage,
    lane: laneOf(s.coin, Date.now()),
    createdAt: s.coin.createdAt,
    socials: s.coin.socials,
    score: Number.isFinite(s.score) ? s.score : null,
    hotSince: s.hotSince,
    verdict: verdict(s.screens),
    screens: s.screens,
    features: f,
    holders: s.holders && {
      at: s.holders.at,
      top10ExPoolPct: s.holders.top10ExPoolPct,
      totalHolders: s.holders.totalHolders,
      insidersDetected: s.holders.insidersDetected,
    },
    social: s.social,
    dev: s.dev,
    funding: s.funding,
    setups: s.setups,
    analysis: s.analysis,
    held: pinned.has(s.coin.mint),
    pairAddress: pairAddress(s.coin),
    quote: s.quote,
    curveProgress: s.coin.curveProgress,
    mcapUsd: s.coin.mcapUsd,
  };
}

/** JSON request body, capped at 16 KB. */
function readJson(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 16_384) req.destroy(new Error("Body too large"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: import("node:http").ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "POST" && url.pathname === "/api/control") {
    const action = url.searchParams.get("action");
    if (action !== "pause" && action !== "resume") return send(res, 400, { error: "action must be pause or resume" });
    const r = control(action);
    return send(res, 200, { ok: r.status === "applied", ...r });
  }
  if (url.pathname === "/api/commands" && req.method === "POST") {
    readJson(req)
      .then((body) => {
        if (workerState !== "running") return send(res, 409, { error: `Worker is ${workerState}`, reasonCodes: ["worker_not_running"] });
        const r = executeCommand(body);
        return send(res, r.httpStatus, r.body);
      })
      .catch((e) => send(res, 400, { error: e instanceof Error ? e.message : "Bad request" }));
    return;
  }
  const cm = url.pathname.match(/^\/api\/commands\/([A-Za-z0-9_-]{1,100})$/);
  if (cm) {
    const c = commandStatus(cm[1]);
    return c ? send(res, 200, c) : send(res, 404, { error: "Unknown command" });
  }
  if (url.pathname === "/api/health") return send(res, 200, health());
  if (url.pathname === "/api/capabilities") return send(res, 200, capabilityReport());
  if (url.pathname === "/api/jobs") return send(res, 200, jobsReport());
  if (url.pathname === "/api/reconciliation") return send(res, 200, reconciliationReport());
  if (url.pathname === "/api/traders") {
    if (req.method === "GET") return send(res, 200, tradersReport());
    if (req.method === "POST") {
      readJson(req)
        .then((body) => {
          if (body.action === "remove") {
            const removed = unwatchWallet(String(body.address ?? ""));
            return send(res, removed ? 200 : 404, removed ? { ok: true } : { error: "Not on the watchlist" });
          }
          const w = watchWallet(body);
          return "error" in w ? send(res, 400, w) : send(res, 200, w);
        })
        .catch((e) => send(res, 400, { error: e instanceof Error ? e.message : "Bad request" }));
      return;
    }
  }
  if (url.pathname === "/api/pulse") {
    if (req.method === "GET") return send(res, 200, pulseReport());
    if (req.method === "POST") {
      readJson(req)
        .then((body) => {
          const col = body.column as ColumnId;
          if (!COLUMNS.some((c) => c.id === col)) return send(res, 400, { error: "Unknown column" });
          const f = setFilters(col, body.preset ? "preset" : ((body.filters ?? {}) as Record<string, unknown>));
          return send(res, 200, f);
        })
        .catch((e) => send(res, 400, { error: e instanceof Error ? e.message : "Bad request" }));
      return;
    }
  }
  if (url.pathname === "/api/funnel") return send(res, 200, funnelReport(Math.min(48, Number(url.searchParams.get("hours")) || 6)));
  if (url.pathname === "/api/portfolio") return send(res, 200, portfolioReport());
  if (url.pathname === "/api/wallet") return send(res, 200, walletSummary());
  if (url.pathname === "/api/dataset") return send(res, 200, datasetSummary());
  if (url.pathname === "/api/evidence") return send(res, 200, evidenceReport());
  if (url.pathname === "/api/research") {
    const mint = url.searchParams.get("mint");
    if (mint && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return send(res, 400, { error: "Invalid mint" });
    return send(res, 200, researchReport(mint || undefined));
  }
  if (url.pathname === "/api/dataset-csv") {
    res.writeHead(200, {
      "content-type": "text/csv",
      "content-disposition": 'attachment; filename="early-life-dataset.csv"',
      "cache-control": "no-store",
    });
    return res.end(datasetCsv());
  }
  if (url.pathname === "/api/state") {
    const hot = [...coins.values()].filter((s) => s.hot).map(summary);
    return send(res, 200, {
      now: Date.now(),
      startedAt: stats.startedAt,
      stats: { ...stats, tracked: coins.size, hot: hot.length },
      http: httpStats(),
      analyst: {
        ...analystHealth,
        callsLastHour: analystHealth.calls.length,
        maxPerHour: ANALYST.maxPerHour,
        model: ANALYST.model,
        calls: undefined,
      },
      treg: tregHealth,
      regime,
      hot,
    });
  }
  if (url.pathname === "/api/activity") {
    const before = Number(url.searchParams.get("before")) || undefined;
    const mint = url.searchParams.get("mint");
    return send(
      res,
      200,
      activity(
        Math.min(200, Number(url.searchParams.get("limit")) || 60),
        before,
        mint && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) ? mint : undefined,
      ),
    );
  }
  const m = url.pathname.match(/^\/api\/coin\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
  if (m) {
    const mint = m[1];
    const fills = agentFills(mint);
    const s = coins.get(mint);
    if (s)
      return send(res, 200, {
        ...summary(s),
        tracked: true,
        holdersReport: s.holders,
        recentTrades: s.trades.slice(-60).reverse(),
        fills,
        traders: tradersOnCoin(s),
        coverage: tapeCoverage(s),
      });
    // No longer watched: still show what we know and what the agent did.
    const c = storedCoin(mint);
    if (!c && !fills.length) return send(res, 404, { error: "Unknown coin" });
    return send(res, 200, {
      mint,
      symbol: c?.symbol ?? null,
      name: c?.name ?? null,
      stage: c?.stage ?? null,
      pairAddress: c ? pairAddress(c) : null,
      socials: c?.socials ?? null,
      tracked: false,
      fills,
    });
  }
  send(res, 404, { error: "not found" });
});

// ---------- health ----------

/** recovering → running → draining → stopped; faulted if startup integrity fails. */
let workerState: "recovering" | "running" | "draining" | "stopped" | "faulted" = "recovering";
const recovery: { migrations: number[]; backup: string | null; restoredMints: number; missingMints: string[]; error?: string } = {
  migrations: [],
  backup: null,
  restoredMints: 0,
  missingMints: [],
};
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

function health() {
  const r = reconciliationReport();
  return {
    workerState,
    heartbeatAt: Date.now(),
    startedAt: stats.startedAt,
    stateRevision: stateRevision(),
    schemaVersions: appliedVersions(),
    recovery,
    reconciliation: { ok: r.ok, issues: r.issues },
    eventLoopDelayMs: { p50: loopDelay.percentile(50) / 1e6, p99: loopDelay.percentile(99) / 1e6, max: loopDelay.max / 1e6 },
    hosts: httpStats(),
    executionModel: "core_approximate_v1 (local AMM estimate; fill modeled atomically at the first fresh quote after latency)",
  };
}

// ---------- start ----------

try {
  const m = runMigrations(MIGRATIONS);
  recovery.migrations = m.applied;
  recovery.backup = m.backup;
  if (m.applied.length) journal("migrations", null, m);
} catch (e) {
  // Financial mutations stay blocked; diagnostics remain readable.
  workerState = "faulted";
  recovery.error = e instanceof Error ? e.message : String(e);
  console.error("[migrations]", recovery.error);
}
restore();
restorePortfolio();
restoreEpisodes();
recoverJobs();
markVersionStart();
// Every market the portfolio depends on is restored regardless of age or discovery status.
{
  const need = obligationMints();
  recovery.missingMints = ensureCoins(need);
  recovery.restoredMints = need.size - recovery.missingMints.length;
  journal("recovery", null, { obligations: need.size, missing: recovery.missingMints });
}
for (const m of heldMints()) pinned.add(m);
if (workerState === "recovering") workerState = reconciliationReport().ok ? "running" : "faulted";
if (workerState === "faulted") console.error("[recovery] worker faulted:", recovery.error ?? reconciliationReport().issues.join("; "));
server.listen(CONFIG.port, "127.0.0.1", () => console.log(`agent API on http://127.0.0.1:${CONFIG.port}`));
journal("start", null, { config: CONFIG });

loop("universe", CONFIG.universe.refreshMs, refreshUniverse);
// Real-time launches and migrations (free PumpPortal subscriptions only).
if (process.env.LIFECYCLE_STREAM !== "off") startLifecycleStream();
loop("tape", 1_000, () => tapeTick(evaluate));
loop("reports", 5_000, reportsTick);
loop("quotes", 2_000, quoteTick);
loop("analyst", 5_000, analystTick);
loop("regime", 60_000, async () => regimeTick());
loop("wallets", 5_000, walletsTick);
loop("dataset-sample", 20_000, sampleTick);
loop("dataset-label", 60_000, labelTick);
tradeListeners.push(onTrades);
loop("pulse", 3_000, () => pulseTick());
loop("traders", 10 * 60_000, async () => {
  const n = discoverTraders();
  console.log(`[traders] ${n} discovered wallets ranked`);
});
// Re-evaluate every hot coin each second so time-based features (windows, exhaustion) stay current between trades.
loop("evaluate", 1_000, async () => {
  for (const s of coins.values()) if (s.hot) evaluate(s);
});
loop("portfolio", 1_000, async () => {
  // A faulted worker (schema or reconciliation failure) makes no financial changes.
  if (workerState !== "running") return;
  portfolioTick();
  pinned.clear();
  for (const m of heldMints()) pinned.add(m);
});
loop("prune", 10 * 60_000, async () => {
  prune(new Set([...coins.values()].filter((s) => s.hot).map((s) => s.coin.mint).concat([...obligationMints()])), 24 * 3600_000);
});

// launchd sends SIGTERM on stop; Ctrl-C sends SIGINT.
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    // Drain: no new admissions; unsubmitted buys are cancelled (their reservations released). Open
    // positions and their exit obligations are persisted and restored on the next start.
    workerState = "draining";
    const cancelled = (["agent", "shadow", "baseline"] as const).reduce((n, id) => n + cancelPendingBuys(id, "Worker stopping"), 0);
    journal("stop", null, { signal: sig, cancelledBuys: cancelled, openPositions: heldMints().size });
    workerState = "stopped";
    stopLifecycleStream();
    server.close();
    process.exit(0);
  });
