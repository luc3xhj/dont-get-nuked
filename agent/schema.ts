// The registered migrations, applied once each (in order, after a verified backup) at worker start.
import { CONFIG } from "./config";
import { db } from "./db";
import { hasOpening, post, toLamports } from "./ledger";
import { addColumn, type Migration } from "./migrations";
import { RISK } from "./portfolio";

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "ledger_legacy_import",
    // Accounts created before the ledger: one opening credit, plus the pre-ledger result as a single
    // provenance-marked adjustment, so cash = Σ ledger without pretending fills were reconstructed.
    up: () => {
      for (const row of db.prepare("SELECT id, data FROM accounts").all() as { id: string; data: string }[]) {
        if (hasOpening(row.id)) continue;
        const cash = Number(JSON.parse(row.data).cash);
        const opening = toLamports(RISK.startCash);
        post({ account: row.id, type: "opening_capital", cashLamports: opening, payload: { startCash: RISK.startCash, source: "legacy_import" } });
        const diff = toLamports(cash) - opening;
        if (diff !== 0)
          post({
            account: row.id,
            type: "legacy_adjustment",
            cashLamports: diff,
            payload: {
              reason: "Pre-ledger trading result imported from the account balance; individual fills were not reconstructed.",
              previousCashSol: cash,
              strategyVersionAtImport: CONFIG.strategyVersion,
            },
          });
      }
    },
  },
  {
    version: 2,
    name: "closed_risk_definition",
    // Label every pre-existing closed trade with its original risk definition. A non-positive legacy
    // denominator (e.g. entry filled below the stop) makes R unusable; the cash result is kept as is.
    up: () => {
      const rows = db.prepare("SELECT id, data FROM closed").all() as { id: string; data: string }[];
      const upd = db.prepare("UPDATE closed SET data = ? WHERE id = ?");
      for (const r of rows) {
        const c = JSON.parse(r.data);
        if (c.riskDefinitionVersion) continue;
        const pnl = Number(c.pnlSol);
        const rv = Number(c.r);
        // A loss with positive R (or a win with negative R) can only come from a negative denominator.
        const rValid = !(pnl !== 0 && rv !== 0 && Math.sign(pnl) !== Math.sign(rv));
        upd.run(JSON.stringify({ ...c, riskDefinitionVersion: "legacy_v1", rValid, originalR: c.r }), r.id);
      }
    },
  },
  {
    version: 3,
    name: "trade_received_at",
    // When each trade reached the worker (its availability), separately from the chain time `ts`.
    up: () => addColumn("trades", "received_at", "INTEGER"),
  },
];
