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
import { tregHealth } from "./research";
import { control, heldMints, onSignals, portfolioReport, portfolioTick, restorePortfolio, walletSummary } from "./portfolio";
import { evaluateSetups } from "./setups";
import { coins, devHistory, laneOf, pairAddress, pinned, quoteTick, refreshUniverse, reportsTick, restore, stats, tapeTick, type CoinState } from "./state";

const lastArmed = new Map<string, number>();

function evaluate(s: CoinState) {
  s.features = computeFeatures(s);
  s.screens = runScreens(s);
  s.setups = evaluateSetups(s, devHistory(s.coin.creator, s.coin.mint));
  // Note when a setup first arms (once per coin+setup per 10 minutes) for the activity feed.
  for (const x of s.setups) {
    const key = `${s.coin.mint}:${x.setup}`;
    if (x.status === "armed" && Date.now() - (lastArmed.get(key) ?? 0) > 10 * 60_000) {
      lastArmed.set(key, Date.now());
      journal("armed", s.coin.mint, { setup: x.setup, passed: x.trigger.filter((k) => k.ok).length, total: x.trigger.length });
    }
  }
  const fired = s.setups.filter((x) => x.status === "fire");
  if (fired.length) onSignals(s, fired);
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
    holders: s.holders && { at: s.holders.at, top10ExPoolPct: s.holders.top10ExPoolPct, totalHolders: s.holders.totalHolders, insidersDetected: s.holders.insidersDetected },
    social: s.social,
    setups: s.setups,
    analysis: s.analysis,
    held: pinned.has(s.coin.mint),
    pairAddress: pairAddress(s.coin),
    quote: s.quote,
    curveProgress: s.coin.curveProgress,
    mcapUsd: s.coin.mcapUsd,
  };
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
    control(action);
    return send(res, 200, { ok: true });
  }
  if (url.pathname === "/api/portfolio") return send(res, 200, portfolioReport());
  if (url.pathname === "/api/wallet") return send(res, 200, walletSummary());
  if (url.pathname === "/api/state") {
    const hot = [...coins.values()].filter((s) => s.hot).map(summary);
    return send(res, 200, {
      now: Date.now(),
      startedAt: stats.startedAt,
      stats: { ...stats, tracked: coins.size, hot: hot.length },
      http: httpStats(),
      analyst: { ...analystHealth, callsLastHour: analystHealth.calls.length, maxPerHour: ANALYST.maxPerHour, model: ANALYST.model, calls: undefined },
      treg: tregHealth,
      hot,
    });
  }
  if (url.pathname === "/api/activity") {
    const before = Number(url.searchParams.get("before")) || undefined;
    const mint = url.searchParams.get("mint");
    return send(res, 200, activity(Math.min(200, Number(url.searchParams.get("limit")) || 60), before, mint && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) ? mint : undefined));
  }
  const m = url.pathname.match(/^\/api\/coin\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
  if (m) {
    const mint = m[1];
    const fills = agentFills(mint);
    const s = coins.get(mint);
    if (s) return send(res, 200, { ...summary(s), tracked: true, holdersReport: s.holders, recentTrades: s.trades.slice(-60).reverse(), fills });
    // No longer watched: still show what we know and what the agent did.
    const c = storedCoin(mint);
    if (!c && !fills.length) return send(res, 404, { error: "Unknown coin" });
    return send(res, 200, { mint, symbol: c?.symbol ?? null, name: c?.name ?? null, stage: c?.stage ?? null, pairAddress: c ? pairAddress(c) : null, socials: c?.socials ?? null, tracked: false, fills });
  }
  send(res, 404, { error: "not found" });
});

// ---------- start ----------

restore();
restorePortfolio();
for (const m of heldMints()) pinned.add(m);
server.listen(CONFIG.port, "127.0.0.1", () => console.log(`agent API on http://127.0.0.1:${CONFIG.port}`));
journal("start", null, { config: CONFIG });

loop("universe", CONFIG.universe.refreshMs, refreshUniverse);
loop("tape", 1_000, () => tapeTick(evaluate));
loop("reports", 5_000, reportsTick);
loop("quotes", 2_000, quoteTick);
loop("analyst", 5_000, analystTick);
// Re-evaluate every hot coin each second so time-based features (windows, exhaustion) stay current between trades.
loop("evaluate", 1_000, async () => {
  for (const s of coins.values()) if (s.hot) evaluate(s);
});
loop("portfolio", 1_000, async () => {
  portfolioTick();
  pinned.clear();
  for (const m of heldMints()) pinned.add(m);
});
loop("prune", 10 * 60_000, async () => {
  prune(new Set([...coins.values()].filter((s) => s.hot).map((s) => s.coin.mint)), 24 * 3600_000);
});

// launchd sends SIGTERM on stop; Ctrl-C sends SIGINT.
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    journal("stop", null, { signal: sig });
    server.close();
    process.exit(0);
  });
