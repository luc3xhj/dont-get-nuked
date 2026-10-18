// Agent worker: runs continuously, independent of the browser.
//   npm run agent
// Phase 1: universe, live trade tapes, holders/socials, features, screens, and a local JSON API.
import { createServer } from "node:http";
import { CONFIG } from "./config";
import { journal, prune } from "./db";
import { computeFeatures } from "./features";
import { httpStats } from "./http";
import { runScreens, verdict } from "./screens";
import { control, heldMints, onSignals, portfolioReport, portfolioTick, restorePortfolio } from "./portfolio";
import { evaluateSetups } from "./setups";
import { coins, devHistory, laneOf, pinned, quoteTick, refreshUniverse, reportsTick, restore, stats, tapeTick, type CoinState } from "./state";

function evaluate(s: CoinState) {
  s.features = computeFeatures(s);
  s.screens = runScreens(s);
  s.setups = evaluateSetups(s, devHistory(s.coin.creator, s.coin.mint));
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
    held: pinned.has(s.coin.mint),
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
  if (url.pathname === "/api/state") {
    const hot = [...coins.values()].filter((s) => s.hot).map(summary);
    return send(res, 200, {
      now: Date.now(),
      startedAt: stats.startedAt,
      stats: { ...stats, tracked: coins.size, hot: hot.length },
      http: httpStats(),
      hot,
    });
  }
  const m = url.pathname.match(/^\/api\/coin\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
  if (m) {
    const s = coins.get(m[1]);
    if (!s) return send(res, 404, { error: "not tracked" });
    return send(res, 200, { ...summary(s), holdersReport: s.holders, recentTrades: s.trades.slice(-60).reverse() });
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

process.on("SIGINT", () => {
  journal("stop", null, {});
  process.exit(0);
});
