// Real-time lifecycle stream (PumpPortal free data socket): new tokens and migrations as they happen,
// instead of waiting for the next list poll. One connection, reconnect with backoff, and only the free
// subscriptions: paid trade subscriptions are refused before anything is sent.
import { DENIED_OPERATIONS, recordCapabilityResult, registerStreamStats } from "./capabilities";
import { db, journal } from "./db";
import { coins, ingestStreamCoin, recordStreamMigration } from "./state";
import type { Coin } from "./types";

const URL_ = "wss://pumpportal.fun/api/data";
const FREE_SUBSCRIPTIONS = ["subscribeNewToken", "subscribeMigration"] as const;

db.exec(`
  CREATE TABLE IF NOT EXISTS lifecycle_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mint TEXT NOT NULL,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    event_at INTEGER,
    received_at INTEGER NOT NULL,
    signature TEXT,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS lifecycle_mint ON lifecycle_events (mint, kind);
  CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_dedupe ON lifecycle_events (mint, kind, source);
`);

type Stat = { events: number; lastEventAt: number | null; connected: boolean; reconnects: number; gapMs: number };
const stats: Record<string, Stat> = {
  "pumpportal.new_token": { events: 0, lastEventAt: null, connected: false, reconnects: 0, gapMs: 0 },
  "pumpportal.migration": { events: 0, lastEventAt: null, connected: false, reconnects: 0, gapMs: 0 },
};
registerStreamStats(() => stats);

/** Sends a subscription only if it is one of the free ones. */
export function subscribeMessage(method: string): string {
  if (DENIED_OPERATIONS.has(method) || !(FREE_SUBSCRIPTIONS as readonly string[]).includes(method))
    throw new Error(`Subscription ${method} is not a verified free capability`);
  return JSON.stringify({ method });
}

const insertEvent = db.prepare(
  "INSERT OR IGNORE INTO lifecycle_events (mint, kind, source, event_at, received_at, signature, payload) VALUES (?, ?, 'pumpportal', NULL, ?, ?, ?)",
);

/** Handles one message; exported for fixture tests. Returns what it recognized. */
export function handleMessage(raw: string, receivedAt = Date.now()): "create" | "migration" | "ignored" {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(raw);
  } catch {
    return "ignored";
  }
  const mint = typeof d.mint === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(d.mint) ? d.mint : null;
  if (!mint) return "ignored";
  if (d.txType === "create") {
    insertEvent.run(mint, "create", receivedAt, (d.signature as string) ?? null, JSON.stringify({ name: d.name, symbol: d.symbol, creator: d.traderPublicKey, pool: d.pool }));
    stats["pumpportal.new_token"].events++;
    stats["pumpportal.new_token"].lastEventAt = receivedAt;
    if (!coins.has(mint)) {
      const coin: Coin = {
        mint,
        symbol: String(d.symbol ?? "").slice(0, 20) || mint.slice(0, 4),
        name: String(d.name ?? "").slice(0, 60),
        creator: String(d.traderPublicKey ?? ""),
        curve: String(d.bondingCurveKey ?? ""),
        pool: null,
        stage: "curve",
        // The stream carries no event time: receipt is an upper bound on creation, labelled as such.
        createdAt: receivedAt,
        launchObservedAt: receivedAt,
        socials: { twitter: null, website: null, telegram: null },
        replies: 0,
        mcapUsd: 0,
        athMcapUsd: null,
        curveProgress: 0,
        lastTradeAt: receivedAt,
        firstSeen: receivedAt,
        updatedAt: receivedAt,
      };
      ingestStreamCoin(coin);
    }
    return "create";
  }
  if (d.txType === "migrate" || d.txType === "migration") {
    const first = insertEvent.run(mint, "migration", receivedAt, (d.signature as string) ?? null, JSON.stringify({ pool: d.pool ?? null }));
    stats["pumpportal.migration"].events++;
    stats["pumpportal.migration"].lastEventAt = receivedAt;
    if (stats["pumpportal.migration"].events === 1)
      recordCapabilityResult("pumpportal.migration", "live_checked", { firstEventMint: mint, receivedAt });
    if (first.changes) recordStreamMigration(mint, receivedAt, typeof d.pool === "string" && d.pool.length > 30 ? d.pool : null);
    return "migration";
  }
  return "ignored";
}

let socket: WebSocket | null = null;
let backoff = 1_000;
let disconnectedAt: number | null = null;

export function startLifecycleStream() {
  if (typeof WebSocket === "undefined") return;
  socket = new WebSocket(URL_);
  socket.onopen = () => {
    backoff = 1_000;
    for (const k of Object.keys(stats)) {
      stats[k].connected = true;
      if (disconnectedAt) stats[k].gapMs += Date.now() - disconnectedAt;
    }
    if (disconnectedAt) journal("stream_gap", null, { source: "pumpportal", fromMs: disconnectedAt, toMs: Date.now() });
    disconnectedAt = null;
    for (const m of FREE_SUBSCRIPTIONS) socket!.send(subscribeMessage(m));
  };
  socket.onmessage = (m) => handleMessage(String(m.data));
  socket.onclose = () => {
    for (const k of Object.keys(stats)) {
      stats[k].connected = false;
      stats[k].reconnects++;
    }
    disconnectedAt ??= Date.now();
    // Bounded backoff with jitter; one connection at a time as PumpPortal asks.
    setTimeout(startLifecycleStream, backoff + Math.random() * 500);
    backoff = Math.min(backoff * 2, 60_000);
  };
  socket.onerror = () => socket?.close();
}

export const stopLifecycleStream = () => {
  if (socket) {
    socket.onclose = null;
    socket.close();
  }
};
