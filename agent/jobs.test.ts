import assert from "node:assert/strict";
import { test } from "node:test";

test("research jobs: priority then deadline, dedupe, expiry, and reports usable only after availability", async () => {
  process.env.AGENT_DB = ":memory:";
  const { enqueue, nextJob, startJob, finishJob, jobsReport, recoverJobs } = await import("./jobs");
  const { compareAnalysis } = await import("./analysis-impact");
  const t0 = 1_800_000_000_000;

  const low = enqueue("token_research", "mintA", 1, t0 + 20 * 60_000, {}, t0);
  const urgent = enqueue("token_research", "mintB", 8, t0 + 2 * 60_000, {}, t0);
  const again = enqueue("token_research", "mintA", 4, t0 + 30 * 60_000, {}, t0 + 1);
  assert.equal(again.id, low.id, "one open job per type and subject");
  assert.equal(again.priority, 4, "priority raised");
  assert.equal(nextJob(t0)!.id, urgent.id, "higher priority first");

  // Past its deadline a queued job expires instead of running late.
  const stale = enqueue("narrative_update", "topic", 9, t0 + 1_000, {}, t0);
  const next = nextJob(t0 + 5 * 60_000)!;
  assert.notEqual(next.id, stale.id);
  assert.equal(jobsReport(24 * 3600_000, t0 + 5 * 60_000).byType.narrative_update.expired, 1);

  startJob(next.id, t0 + 5 * 60_000, t0 + 5 * 60_000);
  recoverJobs(t0 + 6 * 60_000);
  assert.equal(jobsReport(24 * 3600_000, t0 + 6 * 60_000).byType.token_research.failed, 1, "a crash leaves no phantom running job");
  finishJob(urgent.id, "done", { reportId: "r1" }, t0 + 7 * 60_000);

  // A report can't influence a decision made before it became available.
  const analysis = {
    at: t0, availableAt: t0 + 60_000, expiresAt: t0 + 10 * 60_000, model: "m", verdict: "reject" as const, conviction: 1, narrativeType: "tweet" as const,
    narrative: "n", contractVerified: "unknown" as const, copycat: false, redFlags: ["x"], greenFlags: [], thesis: "t", wouldChangeMind: "w", sources: [], durationMs: 1,
  };
  const input = { mint: "m", analysis, commonReasons: [], sizeFor: () => 0.1, defaultScale: 0.5, minimum: 0.05 };
  assert.equal(compareAnalysis({ ...input, now: t0 + 30_000 }).impact.analysisId, null, "not yet available: ignored");
  assert.equal(compareAnalysis({ ...input, now: t0 + 30_000 }).actual.take, true, "before availability the reject can't block");
  assert.equal(compareAnalysis({ ...input, now: t0 + 120_000 }).actual.take, false, "after availability it does");
});
