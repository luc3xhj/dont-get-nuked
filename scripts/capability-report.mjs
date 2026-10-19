// Prints the live capability report from the running worker: which data routes are usable, which
// strategies are supported (and the exact reason when not), worker health and reconciliation.
//   npm run report:capabilities
const base = `http://127.0.0.1:${process.env.AGENT_PORT ?? 3101}/api`;
const get = async (p) => {
  const r = await fetch(`${base}${p}`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  return r.json();
};
try {
  const [health, caps, strategies] = await Promise.all([get("/health"), get("/capabilities"), get("/strategies")]);
  console.log(`Worker: ${health.workerState} · schema v${Math.max(0, ...health.schemaVersions)} · reconciliation ${health.reconciliation.ok ? "ok" : "GAP: " + health.reconciliation.issues.join("; ")}`);
  console.log(`Execution model: ${health.executionModel}\n`);
  console.log("Data routes");
  for (const c of caps)
    console.log(`  ${c.state.padEnd(12)} ${c.stage.padEnd(16)} ${c.zeroCost.padEnd(16)} ${c.provider} — ${c.operation}\n${" ".repeat(48)}${c.note}`);
  console.log("\nStrategies");
  for (const s of strategies) console.log(`  ${s.state.padEnd(12)} ${s.sleeve.padEnd(9)} ${s.label} — ${s.reason}`);
} catch (e) {
  console.error(`Worker unreachable (${e.message}). Start it with npm run agent:start.`);
  process.exitCode = 1;
}
