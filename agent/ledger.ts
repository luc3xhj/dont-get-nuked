// The paper accounts' financial authority: an append-only ledger in integer lamports. Every cash
// movement is one event; account cash is the sum of its events (exactly one opening credit per
// account). Callers post events inside the same SQLite transaction as the position/order changes
// they belong to, and never make network or model calls inside that transaction.
import { db } from "./db";

export const LAMPORTS = 1_000_000_000;
export const toLamports = (sol: number) => Math.round(sol * LAMPORTS);
export const toSol = (lamports: number) => lamports / LAMPORTS;

export type LedgerEventType =
  | "opening_capital"
  /** Imported at migration: the pre-ledger balance difference, with provenance (not reconstructed trade by trade). */
  | "legacy_adjustment"
  | "buy_fill"
  | "sell_fill"
  /** Network fee for a submitted attempt that failed. */
  | "attempt_fee";

export type LedgerEvent = {
  seq: number;
  id: string;
  account: string;
  type: LedgerEventType;
  at: number;
  cashLamports: number;
  mint: string | null;
  orderId: string | null;
  positionId: string | null;
  decisionId: string | null;
  /** Funded sleeve the cash movement belongs to (null = unallocated account capital). */
  sleeve?: string | null;
  payload: Record<string, unknown>;
};

db.exec(`
  CREATE TABLE IF NOT EXISTS ledger_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    account TEXT NOT NULL,
    type TEXT NOT NULL,
    at INTEGER NOT NULL,
    cash_lamports INTEGER NOT NULL,
    mint TEXT,
    order_id TEXT,
    position_id TEXT,
    decision_id TEXT,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ledger_account ON ledger_events (account, seq);
  CREATE INDEX IF NOT EXISTS ledger_position ON ledger_events (position_id);
  -- One opening credit per account, and at most one outcome per order attempt.
  CREATE UNIQUE INDEX IF NOT EXISTS ledger_opening ON ledger_events (account) WHERE type = 'opening_capital';
  CREATE UNIQUE INDEX IF NOT EXISTS ledger_order_outcome ON ledger_events (order_id, type) WHERE order_id IS NOT NULL;
`);

const totals = new Map<string, number>();
const insert = db.prepare(
  "INSERT INTO ledger_events (id, account, type, at, cash_lamports, mint, order_id, position_id, decision_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
);

/** Account cash in lamports, from the ledger. */
export function cashLamports(account: string): number {
  if (!totals.has(account)) {
    const row = db.prepare("SELECT COALESCE(SUM(cash_lamports), 0) AS n FROM ledger_events WHERE account = ?").get(account) as { n: number };
    totals.set(account, row.n);
  }
  return totals.get(account)!;
}

export const hasOpening = (account: string) =>
  !!db.prepare("SELECT 1 FROM ledger_events WHERE account = ? AND type = 'opening_capital'").get(account);

/**
 * Appends one event and returns the account's new cash in SOL. Must run inside the caller's transaction;
 * the in-memory total is only updated after the insert succeeds (a rolled-back transaction is reloaded
 * by `resetLedgerCache`).
 */
export function post(e: Omit<LedgerEvent, "seq" | "id" | "at" | "payload" | "mint" | "orderId" | "positionId" | "decisionId" | "sleeve"> &
  Partial<Pick<LedgerEvent, "id" | "at" | "payload" | "mint" | "orderId" | "positionId" | "decisionId" | "sleeve">>): number {
  if (!Number.isInteger(e.cashLamports)) throw new Error(`Ledger amounts are integer lamports (got ${e.cashLamports})`);
  const before = cashLamports(e.account);
  if (!hasSleeveColumn()) ensureSleeveColumn();
  (e.sleeve ? insertWithSleeve() : insert).run(
    e.id ?? crypto.randomUUID(),
    e.account,
    e.type,
    e.at ?? Date.now(),
    e.cashLamports,
    e.mint ?? null,
    e.orderId ?? null,
    e.positionId ?? null,
    e.decisionId ?? null,
    JSON.stringify(e.payload ?? {}),
    ...(e.sleeve ? [e.sleeve] : []),
  );
  totals.set(e.account, before + e.cashLamports);
  return toSol(before + e.cashLamports);
}

// ---------- sleeves: funded partitions of one account's cash ----------

let sleeveCol: boolean | null = null;
const hasSleeveColumn = () => (sleeveCol ??= (db.prepare("PRAGMA table_info(ledger_events)").all() as { name: string }[]).some((c) => c.name === "sleeve"));
export function ensureSleeveColumn() {
  if (!hasSleeveColumn()) db.exec("ALTER TABLE ledger_events ADD COLUMN sleeve TEXT");
  sleeveCol = true;
}
let insertSleeve: ReturnType<typeof db.prepare> | null = null;
const insertWithSleeve = () =>
  (insertSleeve ??= db.prepare(
    "INSERT INTO ledger_events (id, account, type, at, cash_lamports, mint, order_id, position_id, decision_id, payload, sleeve) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ));

db.exec(`
  CREATE TABLE IF NOT EXISTS allocation_events (
    id TEXT PRIMARY KEY,
    account TEXT NOT NULL,
    from_sleeve TEXT,
    to_sleeve TEXT,
    amount_lamports INTEGER NOT NULL,
    at INTEGER NOT NULL,
    reason TEXT NOT NULL
  );
`);

/**
 * Moves capital between unallocated cash (null) and sleeves. Zero account cash delta: allocation is
 * attribution, never income. Must run inside the caller's transaction.
 */
export function allocate(account: string, from: string | null, to: string | null, amountLamports: number, reason: string, at = Date.now()) {
  if (!Number.isInteger(amountLamports) || amountLamports <= 0) throw new Error("Allocation amounts are positive integer lamports");
  db.prepare("INSERT INTO allocation_events (id, account, from_sleeve, to_sleeve, amount_lamports, at, reason) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    crypto.randomUUID(),
    account,
    from,
    to,
    amountLamports,
    at,
    reason,
  );
}

/** A sleeve's cash: allocations in − out + its own trading cash flows. */
export function sleeveCashLamports(account: string, sleeve: string): number {
  ensureSleeveColumn();
  const alloc = db
    .prepare(
      "SELECT COALESCE(SUM(CASE WHEN to_sleeve = ? THEN amount_lamports ELSE 0 END) - SUM(CASE WHEN from_sleeve = ? THEN amount_lamports ELSE 0 END), 0) AS n FROM allocation_events WHERE account = ?",
    )
    .get(sleeve, sleeve, account) as { n: number };
  const flows = db.prepare("SELECT COALESCE(SUM(cash_lamports), 0) AS n FROM ledger_events WHERE account = ? AND sleeve = ?").get(account, sleeve) as { n: number };
  return alloc.n + flows.n;
}
export const hasAllocations = (account: string) => !!db.prepare("SELECT 1 FROM allocation_events WHERE account = ?").get(account);

/** Drops cached totals (after a rollback, or in tests). */
export const resetLedgerCache = () => totals.clear();

export function ledgerEvents(filter: { account?: string; positionId?: string } = {}): LedgerEvent[] {
  const where: string[] = [];
  const args: string[] = [];
  if (filter.account) {
    where.push("account = ?");
    args.push(filter.account);
  }
  if (filter.positionId) {
    where.push("position_id = ?");
    args.push(filter.positionId);
  }
  const rows = db
    .prepare(`SELECT * FROM ledger_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq`)
    .all(...args) as Record<string, unknown>[];
  return rows.map((r) => ({
    seq: r.seq as number,
    id: r.id as string,
    account: r.account as string,
    type: r.type as LedgerEventType,
    at: r.at as number,
    cashLamports: r.cash_lamports as number,
    mint: r.mint as string | null,
    orderId: r.order_id as string | null,
    positionId: r.position_id as string | null,
    decisionId: r.decision_id as string | null,
    payload: JSON.parse(r.payload as string),
  }));
}

/** Net cash a position produced: sell credits minus buy debits minus fees attributed to it. */
export const positionNetLamports = (positionId: string) =>
  (db.prepare("SELECT COALESCE(SUM(cash_lamports), 0) AS n FROM ledger_events WHERE position_id = ?").get(positionId) as { n: number }).n;
