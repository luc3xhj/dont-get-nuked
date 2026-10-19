import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("migrations: verified backup, legacy cash imported once, invalid legacy R flagged", async () => {
  // A file database (backups are skipped for in-memory ones).
  process.env.AGENT_DB = join(mkdtempSync(join(tmpdir(), "dgn-mig-")), "agent.sqlite");
  const { db } = await import("./db");
  await import("./portfolio"); // creates the accounts / closed tables
  const ledger = await import("./ledger");
  const { runMigrations, appliedVersions } = await import("./migrations");
  const { MIGRATIONS } = await import("./schema");

  // A pre-ledger database: an account with traded-down cash and a legacy loss recorded with positive R.
  db.prepare("INSERT INTO accounts (id, data) VALUES (?, ?)").run("agent", JSON.stringify({ id: "agent", cash: 9.918 }));
  db.prepare("INSERT INTO closed (id, account, setup, closed_at, data) VALUES (?, ?, ?, ?, ?)").run(
    "legacy-1",
    "agent",
    "new_dump",
    1,
    JSON.stringify({ id: "legacy-1", pnlSol: -0.00398186, r: 0.202 }),
  );

  const first = runMigrations(MIGRATIONS);
  assert.deepEqual(first.applied, [1, 2, 3, 4]);
  assert.ok(first.backup && existsSync(first.backup), "a verified backup was written before migrating");
  assert.equal(ledger.toSol(ledger.cashLamports("agent")), 9.918, "cash = Σ ledger after import");
  const events = ledger.ledgerEvents({ account: "agent" });
  assert.deepEqual(events.map((e) => e.type), ["opening_capital", "legacy_adjustment"]);
  const legacy = JSON.parse((db.prepare("SELECT data FROM closed WHERE id = 'legacy-1'").get() as { data: string }).data);
  assert.equal(legacy.rValid, false, "a loss with positive R had a negative denominator");
  assert.equal(legacy.originalR, 0.202, "the original value is preserved, not rewritten");
  assert.equal(legacy.pnlSol, -0.00398186);

  const again = runMigrations(MIGRATIONS);
  assert.deepEqual(again.applied, [], "applied once");
  assert.deepEqual(appliedVersions(), [1, 2, 3, 4]);
  assert.equal(ledger.ledgerEvents({ account: "agent" }).length, 2, "no second opening credit");
});
