// Live integration check, isolated from the worker's database and paper portfolio.
async function main() {
  process.env.AGENT_DB = ":memory:";
  const { collectResearch, webSearch, tregHealth } = await import("../agent/research");
  const { runAnalyst, ANALYST } = await import("../agent/analyst");
  const mintIndex = process.argv.indexOf("--mint");
  if (mintIndex >= 0) {
    const mint = process.argv[mintIndex + 1];
    if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) throw new Error("--mint requires a Solana contract address");
    const response = await fetch(`http://127.0.0.1:3101/api/coin/${mint}`);
    if (!response.ok) throw new Error(`Local coin lookup HTTP ${response.status}`);
    const coin = await response.json();
    const research = await collectResearch({ mint, name: coin.name ?? coin.symbol ?? mint, symbol: coin.symbol ?? "", socials: coin.socials ?? { twitter: null, website: null, telegram: null }, social: coin.social });
    console.log(JSON.stringify({ step: "multi-query research", mint, symbol: coin.symbol, searches: research.searches, sources: research.sources }, null, 2));
    if (!research.searches.some((q) => q.status === "ok" || q.status === "empty")) throw new Error("No search completed");
    if (research.searches.some((q) => q.costMicro !== null && q.costMicro !== 0)) throw new Error("A search reported a nonzero cost");
    return; // Read-only collection check; no verdict or portfolio writes.
  }
  const results = await webSearch("Solana official documentation");
  if (!results?.length) throw new Error(tregHealth.lastError ?? "Treg search returned no results; check TREG_TOKEN");
  console.log(JSON.stringify({ step: "treg", results: results.length, callId: tregHealth.lastCallId, costMicro: tregHealth.lastCostMicro }));
  const research = { at: Date.now(), searches: [], sources: results.map((r) => ({ ...r, via: "search_snippet", queryKinds: ["identity"], mentionsContract: false })) };
  const { structured, raw } = await runAnalyst(`This is an integration diagnostic. There is no trade candidate. Return neutral with unknown contract verification.\n<evidence>${JSON.stringify({ coin: { name: "Setup diagnostic", mint: "unknown" }, research })}</evidence>`);
  if (structured.verdict !== "neutral" || structured.contractVerified !== "unknown") throw new Error("Unexpected diagnostic verdict");
  console.log(JSON.stringify({ step: "codex", model: ANALYST.model, verdict: structured.verdict, contractVerified: structured.contractVerified, usage: raw.usage }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
