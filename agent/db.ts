import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CONFIG } from "./config";
import type { Coin, Trade } from "./types";

mkdirSync(dirname(CONFIG.dbPath), { recursive: true });
export const db = new DatabaseSync(CONFIG.dbPath);

// Schema changes to existing tables go through versioned migrations (agent/schema.ts), never destructive repair.

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS coins (
    mint TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS trades (
    id TEXT NOT NULL,
    tx TEXT NOT NULL,
    mint TEXT NOT NULL,
    ts INTEGER NOT NULL,
    slot INTEGER NOT NULL,
    wallet TEXT NOT NULL,
    side TEXT NOT NULL,
    sol REAL NOT NULL,
    tokens REAL NOT NULL,
    price_sol REAL NOT NULL,
    program TEXT NOT NULL,
    received_at INTEGER,
    PRIMARY KEY (mint, tx)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS trades_ts ON trades (ts);

  -- Append-only log of everything the agent observed or decided, for calibration later.
  CREATE TABLE IF NOT EXISTS journal (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    mint TEXT,
    kind TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS journal_mint ON journal (mint, ts);

  CREATE TABLE IF NOT EXISTS reports (
    mint TEXT NOT NULL,
    kind TEXT NOT NULL,
    at INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (mint, kind)
  );
`);

const upsertCoin = db.prepare(
  "INSERT INTO coins (mint, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(mint) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
);
export function saveCoin(c: Coin) {
  upsertCoin.run(c.mint, JSON.stringify(c), c.updatedAt);
}

export function loadCoins(sinceMs: number): Coin[] {
  return (db.prepare("SELECT data FROM coins WHERE updated_at > ?").all(sinceMs) as { data: string }[]).map((r) => JSON.parse(r.data));
}

// Prepared on first use: `received_at` may be added by a migration after this module loads.
let insertTrade: ReturnType<typeof db.prepare> | null = null;
export function saveTrades(trades: Trade[]) {
  if (!trades.length) return;
  insertTrade ??= db.prepare(
    "INSERT OR IGNORE INTO trades (id, tx, mint, ts, slot, wallet, side, sol, tokens, price_sol, program, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  db.exec("BEGIN");
  try {
    for (const t of trades)
      insertTrade.run(t.id, t.tx, t.mint, t.ts, t.slot, t.wallet, t.side, t.sol, t.tokens, t.priceSol, t.program, t.receivedAt ?? null);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function loadTrades(mint: string): Trade[] {
  return db
    .prepare(
      "SELECT id, tx, mint, ts, slot, wallet, side, sol, tokens, price_sol AS priceSol, program, received_at AS receivedAt FROM trades WHERE mint = ? ORDER BY id",
    )
    .all(mint)
    .map((t) => ({ ...(t as Trade), receivedAt: (t as { receivedAt: number | null }).receivedAt ?? undefined }));
}

const upsertReport = db.prepare(
  "INSERT INTO reports (mint, kind, at, data) VALUES (?, ?, ?, ?) ON CONFLICT(mint, kind) DO UPDATE SET at = excluded.at, data = excluded.data",
);
export function saveReport(mint: string, kind: string, at: number, data: unknown) {
  upsertReport.run(mint, kind, at, JSON.stringify(data));
}
export function loadReport<T>(mint: string, kind: string): T | null {
  const row = db.prepare("SELECT data FROM reports WHERE mint = ? AND kind = ?").get(mint, kind) as { data: string } | undefined;
  return row ? JSON.parse(row.data) : null;
}

const insertJournal = db.prepare("INSERT INTO journal (ts, mint, kind, data) VALUES (?, ?, ?, ?)");
export function journal(kind: string, mint: string | null, data: unknown) {
  insertJournal.run(Date.now(), mint, kind, JSON.stringify(data));
}

/**
 * Keep the database bounded: drop old tapes and coin records for coins we no longer track. Coins with
 * an open position or a pending order (`keepMints`) and coins any account has traded are always kept,
 * so a held market can be recovered no matter how old it is.
 */
export function prune(keepMints: Set<string>, olderThanMs: number) {
  const cutoff = Date.now() - olderThanMs;
  const stale = (db.prepare("SELECT DISTINCT mint FROM trades WHERE ts < ?").all(cutoff) as { mint: string }[]).map((r) => r.mint);
  for (const mint of stale) if (!keepMints.has(mint)) db.prepare("DELETE FROM trades WHERE mint = ?").run(mint);
  const old = (db.prepare("SELECT mint FROM coins WHERE updated_at < ? AND mint NOT IN (SELECT json_extract(data, '$.mint') FROM closed)").all(cutoff) as {
    mint: string;
  }[]).map((r) => r.mint);
  for (const mint of old) if (!keepMints.has(mint)) db.prepare("DELETE FROM coins WHERE mint = ?").run(mint);
}

/** A coin record regardless of age (for recovering held or pending markets). */
export function loadCoin(mint: string): Coin | null {
  const row = db.prepare("SELECT data FROM coins WHERE mint = ?").get(mint) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as Coin) : null;
}
