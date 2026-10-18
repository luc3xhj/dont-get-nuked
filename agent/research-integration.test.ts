import assert from "node:assert/strict";
import { test } from "node:test";
import type { Analysis } from "./analyst";
import type { CoinState } from "./state";
import type { SetupEval } from "./setups";

test("real paper pipeline preserves report → decision → order → fill → close attribution", async (t) => {
  process.env.AGENT_DB = ":memory:";
  const { db, journal } = await import("./db");
  const { coins } = await import("./state");
  const { restorePortfolio, onSignals, decide, portfolioTick, recentDecisions } = await import("./portfolio");
  const { researchReport } = await import("./research-report");
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  t.mock.method(Math, "random", () => 0.5);
  restorePortfolio();
  const mint = "A".repeat(32);
  const a: Analysis = { id: "entry-report", at: now, expiresAt: now + 300_000, model: "test", verdict: "approve", conviction: 1, narrativeType: "unclear", narrative: "Test context", thesis: "Test evidence", contractVerified: "unknown", copycat: false, redFlags: [], greenFlags: [], wouldChangeMind: "More evidence", sources: [], durationMs: 1, research: { at: now, searches: [], sources: [] } };
  const s: CoinState = {
    coin: { mint, name: "Example", symbol: "EX", creator: "creator", curve: "curve", pool: "pool", stage: "migrated", createdAt: now - 3600_000, socials: { twitter: null, website: null, telegram: null }, replies: 0, mcapUsd: 100000, athMcapUsd: 100000, curveProgress: 1, lastTradeAt: now, firstSeen: now, updatedAt: now },
    quote: { at: now, priceSol: 0.000001, priceUsd: 0.00015, liquidityUsd: 30000, mcapUsd: 100000, reserveTokens: 100_000_000, reserveSol: 100 },
    hot: true, hotSince: now, score: 1, trades: [], ids: new Set(), fromLaunch: false, backfilling: false, backfilled: true, nextPollAt: 0,
    holders: null, social: null, dev: null, funding: null, features: null, screens: [], setups: [], analysis: a,
  };
  coins.set(mint, s);
  const ev: SetupEval = { setup: "migrated_base", status: "fire", structure: [], trigger: [], quality: 1, plan: { entrySol: 0.000001, stopSol: 0.0000008, tp1Sol: 0.000002, tp2Sol: 0.000003, maxHoldMin: 60 } };
  const logAnalysis = (analysis: Analysis) => journal("analysis", mint, { analysis, evidence: { coin: { name: "Example", symbol: "EX" } } });
  logAnalysis(a);
  onSignals(s, []);
  assert.equal(db.prepare("SELECT count(*) AS n FROM journal WHERE kind = 'order'").get()!.n, 0, "analysis alone must never place orders");
  s.screens = [{ id: "liquidity", label: "Thin pool", level: "veto", detail: "Test veto" }];
  assert.equal(decide(s, ev).take, false, "approval must not override a screen veto");
  s.screens = [];
  onSignals(s, [ev]);
  let report = researchReport(mint, now);
  const entry = report.decisions[0];
  assert.equal(entry.effect, "resized_entry");
  assert.equal(entry.analysisId, a.id);
  assert.equal(entry.orders.length, 1, "shadow orders must not be credited to Codex");
  assert.equal(entry.orders[0].status, "unconfirmed");

  // A different report arriving before fill must not rewrite the decision's attribution.
  s.analysis = { ...a, id: "between-decision-and-fill", verdict: "reject", at: now + 1 };
  now += 4000; s.quote!.at = now;
  portfolioTick();
  const position = JSON.parse((db.prepare("SELECT data FROM positions WHERE account = 'agent'").get() as { data: string }).data);
  assert.equal(position.entryAnalysisId, "entry-report");
  assert.equal(position.analystAtEntry, "approve");
  report = researchReport(mint, now);
  assert.equal(report.decisions[0].orders[0].status, "filled");
  assert.equal(report.decisions[0].orders[0].positionId, position.id);

  now += 100;
  s.analysis = { ...a, id: "exit-report", at: now, verdict: "reject" };
  logAnalysis(s.analysis);
  portfolioTick();
  report = researchReport(mint, now);
  assert.equal(report.decisions[0].effect, "exit_requested");
  assert.equal(report.decisions[0].analysisId, "exit-report");
  assert.equal(report.decisions[0].orders[0].status, "unconfirmed");
  now += 4000; s.quote!.at = now;
  portfolioTick();
  recentDecisions.length = 0; // Audit reads the durable journal, not this transient feed.
  report = researchReport(mint, now);
  const exit = report.decisions.find((d) => d.kind === "exit")!;
  assert.equal(exit.orders[0].status, "filled");
  assert.equal(exit.orders[0].closed?.reason, "Analyst turned negative");
  assert.ok(report.decisions.find((d) => d.id === entry.id)?.orders[0].closed);
  const closed = JSON.parse((db.prepare("SELECT data FROM closed WHERE account = 'agent'").get() as { data: string }).data);
  assert.equal(closed.entryAnalysisId, "entry-report");
  assert.equal(closed.exitAnalysisId, "exit-report");

  // An analyst exit must not claim a changed outcome when liquidity already requires an exit.
  const secondMint = "D".repeat(32);
  const second: CoinState = { ...s, coin: { ...s.coin, mint: secondMint }, quote: { ...s.quote!, at: now }, analysis: { ...a, id: "second-entry", at: now } };
  coins.set(secondMint, second);
  onSignals(second, [ev]);
  now += 4000; second.quote!.at = now;
  portfolioTick();
  now += 100;
  second.analysis = { ...a, id: "second-exit", at: now, verdict: "reject" };
  second.quote!.liquidityUsd = 1000;
  portfolioTick();
  const unchangedExit = researchReport(secondMint, now).decisions.find((d) => d.kind === "exit")!;
  assert.equal(unchangedExit.effect, "exit_unchanged");
  assert.equal(unchangedExit.withoutExitReason, "Liquidity pulled");

  journal("decision", mint, { take: false, sizeSol: 0.1, reasons: ["Historical skip"], setup: "new_dump", analyst: { verdict: "reject" } });
  report = researchReport(mint, now);
  assert.equal(report.decisions[0].effect, "legacy_untracked");
  assert.equal(report.decisions[0].analysisId, null, "do not infer causation from a nearby report");
  assert.equal(report.decisions[0].orders.length, 0);
  assert.deepEqual(researchReport("B".repeat(32), now).decisions, []);
});

test("audit distinguishes failed, expired and unconfirmed orders from fills", async () => {
  const { db, journal } = await import("./db");
  const { researchReport } = await import("./research-report");
  const mint = "C".repeat(32);
  for (const status of ["fill_failed", "order_expired", "unconfirmed"]) {
    journal("decision", mint, { id: status, take: true, sizeSol: 0.1, reasons: [], impact: { analysisId: "test-report", ignoredAnalysisId: null, effect: "resized_entry", withoutAnalysis: { take: true, sizeSol: 0.05, reasons: [] } } });
    journal("order", mint, { id: status, decisionId: status, account: "agent", side: "buy" });
    if (status !== "unconfirmed") journal(status, mint, { orderId: status, reason: "Test failure" });
  }
  const report = researchReport(mint);
  assert.deepEqual(report.decisions.map((d) => d.orders[0].status).sort(), ["expired", "failed", "unconfirmed"]);
  assert.ok(report.decisions.every((d) => d.orders[0].sol === null));
  const countBefore = db.prepare("SELECT count(*) AS n FROM journal").get()!.n;
  researchReport(mint);
  assert.equal(db.prepare("SELECT count(*) AS n FROM journal").get()!.n, countBefore, "reading attribution must not produce trades or journal entries");
});

test("reports referenced by decisions remain accessible beyond the latest-report limit", async () => {
  const { journal } = await import("./db");
  const { researchReport } = await import("./research-report");
  const mint = "E".repeat(32);
  for (let i = 0; i < 65; i++) journal("analysis", mint, { analysis: { id: `report-${i}`, at: Date.now(), expiresAt: Date.now() + 10000, sources: [], redFlags: [], greenFlags: [] }, evidence: { coin: { symbol: "EX" } } });
  journal("decision", mint, { id: "linked-old-report", take: false, sizeSol: 0.1, reasons: [], impact: { analysisId: "report-0", ignoredAnalysisId: null, effect: "blocked_entry", withoutAnalysis: { take: true, sizeSol: 0.1, reasons: [] } } });
  const report = researchReport(mint);
  assert.equal(report.truncated.analyses, true);
  assert.equal(report.relatedAnalyses, 1);
  assert.ok(report.analyses.some((a) => a.id === "report-0"));
});
