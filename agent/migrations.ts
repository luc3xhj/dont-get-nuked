// Versioned, additive schema and data migrations. Before any pending migration runs against a file
// database, a consistent backup (VACUUM INTO, which includes committed WAL pages) is written and
// verified. Migrations never delete or rewrite original records; they add tables, columns, or
// provenance-marked import events.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CONFIG } from "./config";
import { db } from "./db";

export type Migration = { version: number; name: string; up: () => void };

db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL, backup TEXT)");

const isFileDb = () => CONFIG.dbPath !== ":memory:" && !CONFIG.dbPath.startsWith("file::memory:");

/** Writes a consistent snapshot of the live database and checks that it opens and passes integrity_check. */
export function backupDatabase(label: string): string | null {
  if (!isFileDb()) return null;
  const dir = join(dirname(CONFIG.dbPath), "backups");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `agent-${stamp}-${label.replace(/[^a-z0-9-]/gi, "_")}.sqlite`);
  db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  const copy = new DatabaseSync(path, { readOnly: true });
  try {
    const ok = (copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
    if (ok !== "ok") throw new Error(`Backup integrity check failed: ${ok}`);
  } finally {
    copy.close();
  }
  return path;
}

export const appliedVersions = () => (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[]).map((r) => r.version);

/** Applies pending migrations in order, each in its own transaction, after one verified backup. */
export function runMigrations(migrations: Migration[]) {
  const done = new Set(appliedVersions());
  const pending = migrations.filter((m) => !done.has(m.version)).sort((a, b) => a.version - b.version);
  if (!pending.length) return { applied: [] as number[], backup: null as string | null };
  const hasData = (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'accounts'").get() as { n: number }).n > 0;
  const backup = hasData ? backupDatabase(`pre-v${pending[0].version}`) : null;
  const applied: number[] = [];
  for (const m of pending) {
    db.exec("BEGIN");
    try {
      m.up();
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at, backup) VALUES (?, ?, ?, ?)").run(m.version, m.name, Date.now(), backup);
      db.exec("COMMIT");
      applied.push(m.version);
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${m.version} (${m.name}) failed and was rolled back: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { applied, backup };
}

const hasColumn = (table: string, col: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
export const addColumn = (table: string, col: string, decl: string) => {
  if (!hasColumn(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
};
