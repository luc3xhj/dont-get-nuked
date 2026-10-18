import assert from "node:assert/strict";
import { test } from "node:test";
import { compareAnalysis } from "./analysis-impact";
import type { Analysis } from "./analyst";

const a: Analysis = { id: "report", at: 100, expiresAt: 200, model: "test", verdict: "approve", conviction: 1, narrativeType: "unclear", narrative: "Context", thesis: "Evidence", contractVerified: "unknown", copycat: false, redFlags: [], greenFlags: [], wouldChangeMind: "More data", sources: [], durationMs: 1 };
const base = { mint: "mint", now: 150, analysis: a, commonReasons: [] as string[], sizeFor: (scale: number) => scale * 0.2, defaultScale: 0.5, minimum: 0.05 };

test("a fresh reject blocks only an otherwise permitted entry", () => {
  const rejected = compareAnalysis({ ...base, analysis: { ...a, verdict: "reject" } });
  assert.equal(rejected.actual.take, false);
  assert.equal(rejected.impact.withoutAnalysis.take, true);
  assert.equal(rejected.impact.effect, "blocked_entry");
  const vetoed = compareAnalysis({ ...base, analysis: { ...a, verdict: "reject" }, commonReasons: ["No edge yet"] });
  assert.equal(vetoed.impact.effect, "other_gates");
});

test("approval cannot bypass any existing deterministic risk gate", () => {
  for (const reason of ["Screen veto", "Market regime bad", "Max drawdown", "Re-entry cooldown", "No edge yet"]) {
    const r = compareAnalysis({ ...base, commonReasons: [reason], analysis: { ...a, conviction: 1.5 } });
    assert.equal(r.actual.take, false);
    assert.equal(r.impact.effect, "other_gates");
    assert.ok(r.actual.reasons.includes(reason));
  }
});

test("sizing changes count only when an entry is possible, and respect caps", () => {
  assert.equal(compareAnalysis(base).impact.effect, "resized_entry");
  const capped = compareAnalysis({ ...base, sizeFor: (scale) => Math.min(0.08, scale * 0.2) });
  assert.equal(capped.impact.effect, "unchanged");
  assert.equal(capped.actual.sizeSol, 0.08);
  const enabled = compareAnalysis({ ...base, sizeFor: (scale) => scale * 0.06 });
  assert.equal(enabled.impact.effect, "enabled_entry");
  const blocked = compareAnalysis({ ...base, analysis: { ...a, conviction: 0.25 }, sizeFor: (scale) => scale * 0.15 });
  assert.equal(blocked.impact.effect, "blocked_entry");
});

test("expired or absent analysis uses the original default and is never credited", () => {
  for (const analysis of [null, { ...a, expiresAt: 150, verdict: "reject" as const }]) {
    const r = compareAnalysis({ ...base, analysis });
    assert.equal(r.actual.take, true);
    assert.equal(r.actual.sizeSol, 0.1);
    assert.equal(r.impact.analysisId, null);
    assert.equal(r.impact.ignoredAnalysisId, analysis ? "report" : null);
    assert.deepEqual(r.actual, r.impact.withoutAnalysis);
  }
});
