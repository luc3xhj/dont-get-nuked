// Early-life rug dataset (playbook §4): the first five minutes of every coin whose tape reaches launch,
// labeled with what happened an hour later. Follows "Catching the Rug" (arXiv 2608.20271): models must be
// trained on the venue's own data, so we collect ours. Coins come from the hot set plus a RANDOM sample
// of fresh launches, so the dataset isn't only coins the agent already found interesting.
import { db, journal } from "./db";
import { budget } from "./http";
import { dsQuotes, tradePage } from "./sources";
import { coins, pairAddress, type CoinState } from "./state";
import type { Coin, Trade } from "./types";

const WINDOW_MS = 5 * 60_000;
const LABEL_AFTER_MS = 60 * 60_000;
const SWAP_URL = "https://swap-api.pump.fun/v2/coins";

db.exec(`
  CREATE TABLE IF NOT EXISTS early (
    mint TEXT PRIMARY KEY,
    launch_at INTEGER NOT NULL,
    captured_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    features TEXT NOT NULL,
    label TEXT,
    label_attempts INTEGER NOT NULL DEFAULT 0
  );
`);

const captured = new Set((db.prepare("SELECT mint FROM early").all() as { mint: string }[]).map((r) => r.mint));
const skipped = new Set<string>();

const std = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) / (m || 1);
};

/** The 23 features from the paper (relative where prices are tiny), plus launch-cohort extras. */
export function earlyFeatures(coin: Coin, launchTape: Trade[]) {
  const t0 = launchTape[0].ts;
  const slot0 = launchTape[0].slot;
  const w = launchTape.filter((t) => t.ts <= t0 + WINDOW_MS);
  const buys = w.filter((t) => t.side === "buy");
  const sells = w.filter((t) => t.side === "sell");
  const buySol = buys.reduce((a, t) => a + t.sol, 0);
  const sellSol = sells.reduce((a, t) => a + t.sol, 0);
  const first = w[0].priceSol;
  const last = w.at(-1)!.priceSol;
  const prices = w.map((t) => t.priceSol);
  const maxIdx = prices.indexOf(Math.max(...prices));
  const after3 = w.find((t) => t.slot >= slot0 + 3)?.priceSol ?? last;
  const secs = (t?: Trade) => (t ? (t.ts - t0) / 1000 : null);

  // Launch cohorts inside the window.
  const bySlot = new Map<number, Set<string>>();
  for (const t of buys) if (t.slot <= slot0 + 10 && t.wallet !== coin.creator) bySlot.set(t.slot, (bySlot.get(t.slot) ?? new Set()).add(t.wallet));
  const bundleWallets = [...bySlot.values()].filter((x) => x.size >= 3).reduce((a, x) => a + x.size, 0);
  const spent = new Map<string, number>();
  for (const t of buys) spent.set(t.wallet, (spent.get(t.wallet) ?? 0) + t.sol);
  const top10 = [...spent.values()]
    .sort((a, b) => b - a)
    .slice(0, 10)
    .reduce((a, b) => a + b, 0);
  const devBuy = buys.filter((t) => t.wallet === coin.creator).reduce((a, t) => a + t.tokens, 0);
  const devSell = sells.filter((t) => t.wallet === coin.creator).reduce((a, t) => a + t.tokens, 0);

  return {
    count_tx: w.length,
    purchase_percentage: w.length ? buys.length / w.length : 0,
    sale_percentage: w.length ? sells.length / w.length : 0,
    unique_buyers: new Set(buys.map((t) => t.wallet)).size,
    unique_sellers: new Set(sells.map((t) => t.wallet)).size,
    total_sol_value: buySol + sellSol,
    buy_sol_value: buySol,
    sell_sol_value: sellSol,
    buy_sell_cnt_ratio: sells.length ? buys.length / sells.length : buys.length,
    buy_sell_value_ratio: sellSol ? buySol / sellSol : buySol,
    price_change_first_to_3_blocks: first ? after3 / first - 1 : 0,
    price_change_first_to_last: first ? last / first - 1 : 0,
    buy_price_std: std(buys.map((t) => t.priceSol)),
    sell_price_std: std(sells.map((t) => t.priceSol)),
    first_buy_time: secs(buys[0]),
    first_sell_time: secs(sells[0]),
    last_trade_time: secs(w.at(-1)),
    max_price_rel: first ? Math.max(...prices) / first : 0,
    min_price_rel: first ? Math.min(...prices) / first : 0,
    min_price_after_max_rel: prices[maxIdx] ? Math.min(...prices.slice(maxIdx)) / prices[maxIdx] : 0,
    first_price_sol: first,
    price_at_5m_sol: last,
    // Extras from the playbook / Setuh: who controls the launch.
    bundle_wallets: bundleWallets,
    top10_buy_share: buySol ? top10 / buySol : 0,
    dev_bought_pct: (devBuy / 1e9) * 100,
    dev_sold_fraction: devBuy ? Math.min(1, devSell / devBuy) : 0,
    socials: [coin.socials.twitter, coin.socials.telegram, coin.socials.website].filter(Boolean).length,
    has_telegram: coin.socials.telegram ? 1 : 0,
  };
}

function save(coin: Coin, tape: Trade[], source: "hot" | "sample") {
  const f = earlyFeatures(coin, tape);
  db.prepare("INSERT OR IGNORE INTO early (mint, launch_at, captured_at, source, features) VALUES (?, ?, ?, ?, ?)").run(
    coin.mint,
    tape[0].ts,
    Date.now(),
    source,
    JSON.stringify(f),
  );
  captured.add(coin.mint);
}

/** Hot coins whose tape reaches launch: capture once they're past five minutes. */
export function captureHot(s: CoinState) {
  if (captured.has(s.coin.mint) || !s.fromLaunch || !s.trades.length) return;
  if (Date.now() - s.trades[0].ts < WINDOW_MS + 15_000) return;
  save(s.coin, s.trades, "hot");
}

/** Random fresh launches (5–15 min old, not hot) using spare pump.fun trade-API budget. */
export async function sampleTick() {
  if (budget(SWAP_URL) < 2) return; // launch backfills for hot coins come first (bucket holds ~2.5)
  const now = Date.now();
  const pool = [...coins.values()].filter(
    (s) =>
      !s.hot &&
      s.coin.stage === "curve" &&
      !captured.has(s.coin.mint) &&
      !skipped.has(s.coin.mint) &&
      now - s.coin.createdAt > WINDOW_MS + 15_000 &&
      now - s.coin.createdAt < 15 * 60_000,
  );
  if (!pool.length) return;
  const s = pool[Math.floor(Math.random() * pool.length)];
  const tape: Trade[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 2; page++) {
    const r = await tradePage(s.coin.mint, cursor);
    tape.push(...r.trades);
    if (!r.hasMore || !r.nextCursor) {
      tape.sort((a, b) => (a.id < b.id ? -1 : 1));
      if (tape.length) save(s.coin, tape, "sample");
      return;
    }
    cursor = r.nextCursor;
  }
  skipped.add(s.coin.mint); // too busy to reach launch in two pages; skip rather than bias with a partial tape
}

/** An hour after launch: did it rug, survive, or graduate? */
export async function labelTick() {
  const rows = db
    .prepare("SELECT mint, features, label_attempts FROM early WHERE label IS NULL AND launch_at < ? ORDER BY launch_at LIMIT 30")
    .all(Date.now() - LABEL_AFTER_MS) as { mint: string; features: string; label_attempts: number }[];
  if (!rows.length) return;
  const coinOf = (mint: string) =>
    coins.get(mint)?.coin ??
    ((r) => (r ? (JSON.parse(r.data) as Coin) : null))(db.prepare("SELECT data FROM coins WHERE mint = ?").get(mint) as { data: string } | undefined);
  const items = rows.map((r) => ({ r, coin: coinOf(r.mint) })).filter((x) => x.coin);
  const quotes = await dsQuotes(items.map((x) => pairAddress(x.coin!)));
  for (const { r, coin } of items) {
    const f = JSON.parse(r.features) as { price_at_5m_sol: number };
    const q = quotes[pairAddress(coin!)];
    const idle = Date.now() - coin!.lastTradeAt > 30 * 60_000;
    if (!q && r.label_attempts < 3) {
      db.prepare("UPDATE early SET label_attempts = label_attempts + 1 WHERE mint = ?").run(r.mint);
      continue;
    }
    const ratio = q && f.price_at_5m_sol ? q.priceSol / f.price_at_5m_sol : null;
    const label = {
      at: Date.now(),
      horizonMin: Math.round((Date.now() - (coin!.createdAt || 0)) / 60_000),
      priceRatioVs5m: ratio,
      graduated: coin!.stage === "migrated",
      idle,
      // Paper's definition, adapted: value collapses ≥ 90% from the 5-minute mark, or it goes idle.
      rug: ratio === null ? idle : ratio <= 0.1 || (idle && ratio < 0.5),
      unknown: ratio === null && !idle,
    };
    db.prepare("UPDATE early SET label = ? WHERE mint = ?").run(JSON.stringify(label), r.mint);
  }
  journal("dataset_labels", null, { labeled: items.length });
}

export function datasetSummary() {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS captured,
              COALESCE(SUM(label IS NOT NULL), 0) AS labeled,
              COALESCE(SUM(json_extract(label, '$.rug') = 1), 0) AS rugs,
              COALESCE(SUM(json_extract(label, '$.graduated') = 1), 0) AS graduated,
              COALESCE(SUM(source = 'sample'), 0) AS sampled
       FROM early`,
    )
    .get() as { captured: number; labeled: number; rugs: number; graduated: number; sampled: number };
  return { ...row, rugRate: row.labeled ? row.rugs / row.labeled : null };
}

/** Labeled rows as CSV for training a classifier offline. */
export function datasetCsv(): string {
  const rows = db.prepare("SELECT mint, launch_at, source, features, label FROM early WHERE label IS NOT NULL ORDER BY launch_at").all() as {
    mint: string;
    launch_at: number;
    source: string;
    features: string;
    label: string;
  }[];
  if (!rows.length) return "mint\n";
  const fk = Object.keys(JSON.parse(rows[0].features));
  const lk = ["rug", "graduated", "idle", "unknown", "priceRatioVs5m", "horizonMin"];
  const cell = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "boolean" ? (v ? 1 : 0) : String(v));
  const lines = [["mint", "launch_at", "source", ...fk, ...lk.map((k) => `label_${k}`)].join(",")];
  for (const r of rows) {
    const f = JSON.parse(r.features);
    const l = JSON.parse(r.label);
    lines.push([r.mint, r.launch_at, r.source, ...fk.map((k) => cell(f[k])), ...lk.map((k) => cell(l[k]))].join(","));
  }
  return lines.join("\n") + "\n";
}
