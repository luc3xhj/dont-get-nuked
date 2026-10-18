// Re-runs every recorded agent decision from its stored snapshot and reports any that no longer
// reproduce (roadmap A4). Usage: npm run replay:decisions [-- --version <strategyVersion>] [-- --limit N]
import { DatabaseSync } from "node:sqlite";
import { CONFIG } from "./config";
import { decideFrom, type DecisionSnapshot } from "./decision";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const file = CONFIG.dbPath;
const db = new DatabaseSync(file, { readOnly: true });
const version = arg("version");
const limit = Number(arg("limit") ?? 1000);
const rows = db
  .prepare(`SELECT id, version, snapshot, result FROM decisions ${version ? "WHERE version = ?" : ""} ORDER BY at DESC LIMIT ?`)
  .all(...(version ? [version, limit] : [limit])) as { id: string; version: string; snapshot: string; result: string }[];

let same = 0;
const diffs: string[] = [];
for (const r of rows) {
  const stored = JSON.parse(r.result);
  const replayed = decideFrom(JSON.parse(r.snapshot) as DecisionSnapshot);
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
  if (stored.take === replayed.take && close(stored.sizeSol, replayed.sizeSol) && JSON.stringify(stored.reasons) === JSON.stringify(replayed.reasons)) same++;
  else diffs.push(`${r.id} (${r.version}): stored take=${stored.take} size=${stored.sizeSol} · replay take=${replayed.take} size=${replayed.sizeSol}`);
}
console.log(`${rows.length} decisions replayed · ${same} identical · ${diffs.length} differ`);
for (const d of diffs.slice(0, 20)) console.log(`  ${d}`);
process.exitCode = diffs.length ? 1 : 0;
