import type { Analysis } from "./analyst";
import type { AnalysisImpact, DecisionOutcome } from "../src/lib/research-types";

export const analysisKey = (mint: string, a: Pick<Analysis, "id" | "at">) => a.id ?? `${mint}:${a.at}`;

/** Compare the same market/account snapshot, changing only the analyst input. No orders are placed. */
export function compareAnalysis(input: {
  mint: string; analysis: Analysis | null; now: number; commonReasons: string[];
  sizeFor: (conviction: number) => number; defaultScale: number; minimum: number;
}): { actual: DecisionOutcome; impact: AnalysisImpact } {
  const { analysis, now, sizeFor, minimum } = input;
  const fresh = analysis && analysis.expiresAt > now ? analysis : null;
  const outcome = (scale: number, reject: boolean): DecisionOutcome => {
    const sizeSol = sizeFor(scale);
    const reasons = [...input.commonReasons];
    if (reject) reasons.push(`Analyst rejected: ${fresh?.redFlags[0] ?? fresh?.thesis ?? "Negative research verdict"}`);
    if (sizeSol < minimum) reasons.push(`Size ${sizeSol.toFixed(3)}◎ below minimum (thin pool or little cash)`);
    return { take: reasons.length === 0, sizeSol, reasons };
  };
  const withoutAnalysis = outcome(input.defaultScale, false);
  const actual = outcome(fresh?.conviction ?? input.defaultScale, fresh?.verdict === "reject");
  const effect: AnalysisImpact["effect"] = !fresh ? (analysis ? "expired_analysis" : "no_analysis")
    : withoutAnalysis.take && !actual.take ? "blocked_entry"
    : !withoutAnalysis.take && actual.take ? "enabled_entry"
    : !actual.take && !withoutAnalysis.take ? "other_gates"
    : Math.abs(actual.sizeSol - withoutAnalysis.sizeSol) > 1e-9 ? "resized_entry"
    : "unchanged";
  return { actual, impact: {
    analysisId: fresh ? analysisKey(input.mint, fresh) : null,
    ignoredAnalysisId: !fresh && analysis ? analysisKey(input.mint, analysis) : null,
    effect, withoutAnalysis,
  } };
}
