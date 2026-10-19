export type QueryKind = "contract" | "identity" | "social" | "website" | "narrative";
export type ResearchQuery = { kind: QueryKind; query: string; purpose: string; domains?: string[] };
export type SearchTrace = ResearchQuery & {
  at: number;
  status: "ok" | "empty" | "error" | "skipped";
  callId: string | null;
  costMicro: number | null;
  error: string | null;
  resultUrls: string[];
};
export type ResearchSource = {
  url: string;
  title: string;
  snippet: string;
  via: "search_snippet" | "linked_social";
  queryKinds: QueryKind[];
  mentionsContract: boolean;
};
export type ResearchBundle = { at: number; searches: SearchTrace[]; sources: ResearchSource[] };

export type ImpactEffect =
  | "blocked_entry"
  | "enabled_entry"
  | "resized_entry"
  | "unchanged"
  | "other_gates"
  | "requirement_satisfied"
  | "no_analysis"
  | "expired_analysis";
export type DecisionOutcome = { take: boolean; sizeSol: number; reasons: string[] };
export type AnalysisImpact = {
  analysisId: string | null;
  ignoredAnalysisId: string | null;
  effect: ImpactEffect;
  withoutAnalysis: DecisionOutcome;
};

export type ResearchAnalysis = {
  id: string; mint: string; symbol: string; name: string; at: number; expiresAt: number;
  verdict: "approve" | "neutral" | "reject"; conviction: number; narrative: string; thesis: string;
  contractVerified: string; redFlags: string[]; greenFlags: string[]; wouldChangeMind: string;
  sources: string[]; research: ResearchBundle | null; legacy: boolean;
};
export type ResearchOrder = {
  id: string; side: string; at: number;
  status: "filled" | "failed" | "expired" | "unconfirmed";
  reason: string | null; positionId: string | null; sol: number | null;
  closed: { at: number; pnlSol: number; reason: string } | null;
};
export type ResearchDecision = {
  id: string; mint: string; symbol: string; at: number; kind: "entry" | "exit"; setup: string;
  analysisId: string | null; ignoredAnalysisId: string | null;
  effect: ImpactEffect | "exit_requested" | "exit_unchanged" | "legacy_untracked";
  actual: DecisionOutcome | null; withoutAnalysis: DecisionOutcome | null;
  reason: string | null; withoutExitReason: string | null; orders: ResearchOrder[];
};
export type ResearchReport = {
  now: number; since: number; mint: string | null;
  relatedAnalyses: number;
  limits: { analyses: number; decisions: number; errors: number };
  truncated: { analyses: boolean; decisions: boolean; errors: boolean };
  analyses: ResearchAnalysis[]; decisions: ResearchDecision[];
  errors: { id: string; at: number; mint: string; symbol: string; error: string; research: ResearchBundle | null }[];
};
