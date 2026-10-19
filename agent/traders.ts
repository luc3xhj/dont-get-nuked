// Traders: wallets worth watching, from two sources.
//   watching   — wallets the user added (name, X handle, note)
//   discovered — wallets our own tape history ranks well: they repeatedly closed trades in profit
// Everything here is computed from trades we already record, so it costs nothing. A watched trader
// buying is evidence to measure, never an instruction to copy.
import { CONFIG } from "./config";
import { db, journal } from "./db";
import { wilsonLower } from "./stats";
import type { CoinState } from "./state";
import type { Trade } from "./types";

export type WatchedWallet = { address: string; name: string; xHandle: string | null; note: string; addedAt: number };
export type DiscoveredWallet = {
  address: string;
  /** Coins where we saw all of the wallet's buys and it sold (almost) everything. */
  closed: number;
  wins: number;
  winRateLower: number;
  realizedSol: number;
  returnOnCost: number;
  avgHoldMin: number;
  coins: number;
  lastActiveAt: number;
  score: number;
};
/** One wallet's position in one coin, from the tape. */
export type TraderOnCoin = {
  address: string;
  name: string | null;
  xHandle: string | null;
  source: "watching" | "discovered";
  firstBuyAt: number;
  entryMcapUsd: number | null;
  /** Current price ÷ the wallet's average buy price. */
  multiple: number | null;
  /** Share of the tokens it bought that it still holds. */
  holdingPct: number;
  solIn: number;
  solOut: number;
  /** Realized + current mark value − cost. */
  pnlSol: number | null;
  lastAction: "buy" | "sell";
  lastActionAt: number;
  /** False when the tape may be missing some of this wallet's trades (numbers are then partial). */
  complete: boolean;
  actions: { ts: number; side: "buy" | "sell"; sol: number }[];
};

export const DISCOVERY = {
  /** Minimum closed coins before a wallet can rank. */
  minClosed: 4,
  /** Wallets trading more coins than this per day of data look like bots. */
  maxCoinsPerDay: 60,
  /** Wallets whose average coin has more trades than this look like bump/volume bots. */
  maxTradesPerCoin: 40,
  /** Buying within this many ms of launch is sniping, which a person can't follow. */
  sniperMs: 10_000,
  maxSniperShare: 0.5,
  /** Average time from first buy to last trade per closed coin; bots that flip in seconds can't be followed. */
  minAvgHoldMs: 60_000,
  /** Realized profit ÷ SOL spent on closed coins: tiny edges on every trade are arbitrage, not judgment. */
  minReturnOnCost: 0.1,
  top: 40,
  everyMs: 10 * 60_000,
};

db.exec(`
  CREATE TABLE IF NOT EXISTS watched_wallets (address TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS wallet_coin (
    wallet TEXT NOT NULL, mint TEXT NOT NULL, first_buy INTEGER NOT NULL, last_ts INTEGER NOT NULL,
    sol_in REAL NOT NULL, sol_out REAL NOT NULL, tok_in REAL NOT NULL, tok_out REAL NOT NULL, trades INTEGER NOT NULL,
    sniped INTEGER NOT NULL, PRIMARY KEY (wallet, mint)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS discovered_wallets (address TEXT PRIMARY KEY, score REAL NOT NULL, data TEXT NOT NULL);
`);

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ---------- watchlist ----------

const watched = new Map<string, WatchedWallet>();
for (const r of db.prepare("SELECT data FROM watched_wallets").all() as { data: string }[]) {
  const w = JSON.parse(r.data) as WatchedWallet;
  watched.set(w.address, w);
}

export function watchWallet(input: { address?: unknown; name?: unknown; xHandle?: unknown; note?: unknown }): WatchedWallet | { error: string } {
  const address = String(input.address ?? "").trim();
  if (!ADDRESS.test(address)) return { error: "Not a valid Solana wallet address" };
  const name = String(input.name ?? "").trim().slice(0, 40) || `${address.slice(0, 4)}…${address.slice(-4)}`;
  const handle = String(input.xHandle ?? "").trim().replace(/^@/, "").replace(/^https?:\/\/(x|twitter)\.com\//, "").split(/[/?]/)[0];
  if (handle && !/^[A-Za-z0-9_]{1,15}$/.test(handle)) return { error: "X handle should be 1–15 letters, numbers or underscores" };
  const prev = watched.get(address);
  const w: WatchedWallet = { address, name, xHandle: handle || null, note: String(input.note ?? "").trim().slice(0, 200), addedAt: prev?.addedAt ?? Date.now() };
  watched.set(address, w);
  db.prepare("INSERT OR REPLACE INTO watched_wallets (address, data) VALUES (?, ?)").run(address, JSON.stringify(w));
  journal("trader_watch", null, { address, name: w.name, action: prev ? "update" : "add" });
  return w;
}

export function unwatchWallet(address: string) {
  if (!watched.delete(address)) return false;
  db.prepare("DELETE FROM watched_wallets WHERE address = ?").run(address);
  journal("trader_watch", null, { address, action: "remove" });
  return true;
}

// ---------- discovery ----------

let discovered = new Map<string, DiscoveredWallet>();
for (const r of db.prepare("SELECT data FROM discovered_wallets ORDER BY score DESC").all() as { data: string }[]) {
  const d = JSON.parse(r.data) as DiscoveredWallet;
  discovered.set(d.address, d);
}

/**
 * Refreshes per wallet-coin aggregates from the stored tape (they outlive tape pruning), then ranks
 * wallets by a conservative win rate on trades we saw completely.
 */
export function discoverTraders(now = Date.now()) {
  db.exec("BEGIN");
  try {
    // Tapes are pruned per coin in full, so every mint still in `trades` has its complete stored history.
    db.prepare(
      `INSERT OR REPLACE INTO wallet_coin (wallet, mint, first_buy, last_ts, sol_in, sol_out, tok_in, tok_out, trades, sniped)
       SELECT t.wallet, t.mint,
         MIN(CASE WHEN t.side = 'buy' THEN t.ts END), MAX(t.ts),
         SUM(CASE WHEN t.side = 'buy' THEN t.sol ELSE 0 END), SUM(CASE WHEN t.side = 'sell' THEN t.sol ELSE 0 END),
         SUM(CASE WHEN t.side = 'buy' THEN t.tokens ELSE 0 END), SUM(CASE WHEN t.side = 'sell' THEN t.tokens ELSE 0 END),
         COUNT(*),
         COALESCE(MIN(CASE WHEN t.side = 'buy' THEN t.ts END) - json_extract(c.data, '$.createdAt') < ?, 0)
       FROM trades t LEFT JOIN coins c ON c.mint = t.mint
       GROUP BY t.wallet, t.mint
       HAVING MIN(CASE WHEN t.side = 'buy' THEN t.ts END) IS NOT NULL`,
    ).run(DISCOVERY.sniperMs);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  const span = db.prepare("SELECT MIN(first_buy) AS lo, MAX(last_ts) AS hi FROM wallet_coin").get() as { lo: number | null; hi: number | null };
  const days = Math.max(1, ((span.hi ?? now) - (span.lo ?? now)) / 86_400_000);
  // Closed = it sold ≥ 90% of what it bought, and never sold more than we saw it buy (no hidden earlier buys).
  const rows = db
    .prepare(
      `SELECT wallet, COUNT(*) AS coins, SUM(trades) AS trades, SUM(sniped) AS sniped, MAX(last_ts) AS last,
         SUM(CASE WHEN tok_out >= 0.9 * tok_in AND tok_out <= 1.02 * tok_in THEN 1 ELSE 0 END) AS closed,
         SUM(CASE WHEN tok_out >= 0.9 * tok_in AND tok_out <= 1.02 * tok_in AND sol_out > sol_in THEN 1 ELSE 0 END) AS wins,
         SUM(CASE WHEN tok_out >= 0.9 * tok_in AND tok_out <= 1.02 * tok_in THEN sol_out - sol_in ELSE 0 END) AS realized,
         SUM(CASE WHEN tok_out >= 0.9 * tok_in AND tok_out <= 1.02 * tok_in THEN sol_in ELSE 0 END) AS spent,
         AVG(CASE WHEN tok_out >= 0.9 * tok_in AND tok_out <= 1.02 * tok_in THEN last_ts - first_buy END) AS hold
       FROM wallet_coin GROUP BY wallet HAVING closed >= ?`,
    )
    .all(DISCOVERY.minClosed) as {
    wallet: string;
    coins: number;
    trades: number;
    sniped: number;
    last: number;
    closed: number;
    wins: number;
    realized: number;
    spent: number;
    hold: number;
  }[];
  const ranked: DiscoveredWallet[] = rows
    .filter(
      (r) =>
        r.realized > 0 &&
        r.spent > 0 &&
        r.realized / r.spent >= DISCOVERY.minReturnOnCost &&
        r.hold >= DISCOVERY.minAvgHoldMs &&
        r.coins / days <= DISCOVERY.maxCoinsPerDay &&
        r.trades / r.coins <= DISCOVERY.maxTradesPerCoin &&
        r.sniped / r.coins <= DISCOVERY.maxSniperShare,
    )
    .map((r) => {
      const winRateLower = wilsonLower(r.wins, r.closed);
      return {
        address: r.wallet,
        closed: r.closed,
        wins: r.wins,
        winRateLower,
        realizedSol: r.realized,
        returnOnCost: r.realized / r.spent,
        avgHoldMin: r.hold / 60_000,
        coins: r.coins,
        lastActiveAt: r.last,
        // Conservative hit rate, plus return on cost (capped) so size of edge counts, not just its frequency.
        score: winRateLower + 0.25 * Math.min(1, r.realized / r.spent),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, DISCOVERY.top);
  db.exec("DELETE FROM discovered_wallets");
  const ins = db.prepare("INSERT INTO discovered_wallets (address, score, data) VALUES (?, ?, ?)");
  for (const d of ranked) ins.run(d.address, d.score, JSON.stringify(d));
  discovered = new Map(ranked.map((d) => [d.address, d]));
  return ranked.length;
}

// ---------- per coin ----------

const sourceOf = (address: string): TraderOnCoin["source"] | null => (watched.has(address) ? "watching" : discovered.has(address) ? "discovered" : null);

/** Watched and discovered wallets that traded this coin, with their position from the tape. */
export function tradersOnCoin(s: CoinState): TraderOnCoin[] {
  const by = new Map<string, Trade[]>();
  for (const t of s.trades) if (sourceOf(t.wallet)) by.set(t.wallet, [...(by.get(t.wallet) ?? []), t]);
  const price = s.quote?.priceSol ?? s.trades.at(-1)?.priceSol ?? null;
  const solUsd = s.quote && s.quote.priceSol ? s.quote.priceUsd / s.quote.priceSol : null;
  const out: TraderOnCoin[] = [];
  for (const [address, trades] of by) {
    const buys = trades.filter((t) => t.side === "buy");
    if (!buys.length) continue;
    const sum = (xs: Trade[], k: "sol" | "tokens") => xs.reduce((a, t) => a + t[k], 0);
    const sells = trades.filter((t) => t.side === "sell");
    const tokIn = sum(buys, "tokens");
    const tokOut = sum(sells, "tokens");
    const solIn = sum(buys, "sol");
    const solOut = sum(sells, "sol");
    const held = Math.max(0, tokIn - tokOut);
    const avgBuy = tokIn ? solIn / tokIn : 0;
    const w = watched.get(address);
    const last = trades.at(-1)!;
    out.push({
      address,
      name: w?.name ?? null,
      xHandle: w?.xHandle ?? null,
      source: sourceOf(address)!,
      firstBuyAt: buys[0].ts,
      entryMcapUsd: solUsd ? buys[0].priceSol * CONFIG.totalSupply * solUsd : null,
      multiple: price && avgBuy ? price / avgBuy : null,
      holdingPct: tokIn ? (held / tokIn) * 100 : 0,
      solIn,
      solOut,
      pnlSol: price !== null ? solOut + held * price - solIn : null,
      lastAction: last.side,
      lastActionAt: last.ts,
      complete: (s.fromLaunch && s.tapeGaps === 0) || tokOut <= tokIn * 1.02,
      actions: trades.slice(-20).map((t) => ({ ts: t.ts, side: t.side, sol: t.sol })),
    });
  }
  return out.sort((a, b) => (a.source === b.source ? b.lastActionAt - a.lastActionAt : a.source === "watching" ? -1 : 1));
}

/** Evidence feature: how many tracked traders hold this coin, and how much of the supply. */
export function trackedHolding(s: CoinState) {
  let watching = 0;
  let discoveredN = 0;
  let tokens = 0;
  const held = new Map<string, number>();
  for (const t of s.trades) if (sourceOf(t.wallet)) held.set(t.wallet, (held.get(t.wallet) ?? 0) + (t.side === "buy" ? t.tokens : -t.tokens));
  for (const [address, tok] of held) {
    if (tok <= 0) continue;
    tokens += tok;
    if (sourceOf(address) === "watching") watching++;
    else discoveredN++;
  }
  return { watching, discovered: discoveredN, heldPct: (tokens / CONFIG.totalSupply) * 100 };
}

/** Journals fresh trades by tracked wallets for the live feed (old backfilled trades are ignored). */
export function onTrades(s: CoinState, fresh: Trade[], now = Date.now()) {
  for (const t of fresh) {
    const source = sourceOf(t.wallet);
    if (!source || now - t.ts > 10 * 60_000) continue;
    const w = watched.get(t.wallet);
    const solUsd = s.quote && s.quote.priceSol ? s.quote.priceUsd / s.quote.priceSol : null;
    journal("trader_trade", s.coin.mint, {
      wallet: t.wallet,
      name: w?.name ?? null,
      xHandle: w?.xHandle ?? null,
      source,
      side: t.side,
      sol: t.sol,
      mcapUsd: solUsd ? t.priceSol * CONFIG.totalSupply * solUsd : null,
    });
  }
}

/** The Traders tab: the watchlist with recent activity, and the discovered ranking. */
export function tradersReport() {
  const recent = db.prepare("SELECT mint, MAX(last_ts) AS last, COUNT(*) AS coins FROM wallet_coin WHERE wallet = ?");
  const lastMint = db.prepare("SELECT mint FROM wallet_coin WHERE wallet = ? ORDER BY last_ts DESC LIMIT 1");
  return {
    discovery: { ...DISCOVERY, ranked: discovered.size },
    watching: [...watched.values()]
      .sort((a, b) => b.addedAt - a.addedAt)
      .map((w) => {
        const r = recent.get(w.address) as { last: number | null; coins: number };
        const d = discovered.get(w.address);
        return {
          ...w,
          coinsSeen: r.coins,
          lastActiveAt: r.last,
          lastMint: r.last ? ((lastMint.get(w.address) as { mint: string }).mint) : null,
          discovered: d ?? null,
        };
      }),
    discovered: [...discovered.values()].map((d) => ({ ...d, watching: watched.has(d.address) })),
  };
}
