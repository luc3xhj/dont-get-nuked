// Read-only audit view. Attribution comes from saved IDs, never proximity in time.
import { db } from "./db";
import { analysisKey } from "./analysis-impact";
import type { Analysis } from "./analyst";
import type { Decision } from "./portfolio";
import type { ResearchAnalysis, ResearchDecision, ResearchOrder, ResearchReport } from "../src/lib/research-types";

type Row = { seq: number; ts: number; mint: string; kind: string; data: string };
db.exec("CREATE INDEX IF NOT EXISTS journal_kind_ts ON journal (kind, ts)");

export function researchReport(mint?: string, now = Date.now()): ResearchReport {
  const since = now - 7 * 86_400_000;
  const limits = { analyses: 60, decisions: 300, errors: 20 };
  const rows = (kinds: string[], limit: number) => db.prepare(`
    SELECT seq, ts, mint, kind, data FROM journal
    WHERE kind IN (${kinds.map(() => "?").join(",")}) AND ts >= ? ${mint ? "AND mint = ?" : ""}
    ORDER BY ts DESC, seq DESC LIMIT ?
  `).all(...kinds, since, ...(mint ? [mint] : []), limit + 1) as Row[];
  const ar = rows(["analysis"], limits.analyses);
  const dr = rows(["decision", "exit_decision"], limits.decisions);
  const er = rows(["analysis_error"], limits.errors);
  const selected = ar.slice(0, limits.analyses);
  // Keep every report referenced by the displayed decisions, even if it falls outside the latest 60.
  const references = dr.slice(0, limits.decisions).flatMap((row) => {
    const d = JSON.parse(row.data);
    return [d.analysisId, d.impact?.analysisId, d.impact?.ignoredAnalysisId].filter(Boolean);
  });
  const related = db.prepare(`SELECT seq, ts, mint, kind, data FROM journal WHERE kind = 'analysis'
    AND coalesce(json_extract(data, '$.analysis.id'), mint || ':' || json_extract(data, '$.analysis.at'))
      IN (SELECT value FROM json_each(?))`).all(JSON.stringify([...new Set(references)])) as Row[];
  const selectedIds = new Set(selected.map((row) => row.seq));
  const extra = related.filter((row) => !selectedIds.has(row.seq));
  const symbols = new Map<string, string>();
  for (const c of db.prepare("SELECT mint, json_extract(data, '$.symbol') AS symbol FROM coins").all() as { mint: string; symbol: string }[]) symbols.set(c.mint, c.symbol);
  const analyses: ResearchAnalysis[] = [...selected, ...extra].sort((a, b) => b.ts - a.ts || b.seq - a.seq).map((row) => {
    const data = JSON.parse(row.data);
    const a = data.analysis as Analysis;
    const symbol = data.evidence?.coin?.symbol ?? symbols.get(row.mint) ?? row.mint.slice(0, 8);
    symbols.set(row.mint, symbol);
    return {
      id: analysisKey(row.mint, a), mint: row.mint, symbol, name: data.evidence?.coin?.name ?? symbol,
      at: a.at, expiresAt: a.expiresAt, verdict: a.verdict, conviction: a.conviction,
      narrative: a.narrative, thesis: a.thesis, contractVerified: a.contractVerified,
      redFlags: a.redFlags, greenFlags: a.greenFlags, wouldChangeMind: a.wouldChangeMind,
      sources: a.sources, research: a.research ?? null, legacy: !a.id,
    };
  });
  const decisions: ResearchDecision[] = dr.slice(0, limits.decisions).map((row) => {
    const d = JSON.parse(row.data) as Decision & { analysisId?: string; setup?: string; reason?: string; effect?: "exit_requested" | "exit_unchanged"; withoutExitReason?: string };
    const exit = row.kind === "exit_decision";
    return {
      id: d.id ?? `legacy-decision-${row.seq}`, mint: row.mint, symbol: symbols.get(row.mint) ?? row.mint.slice(0, 8), at: row.ts,
      kind: exit ? "exit" : "entry", setup: d.setup ?? "Position management",
      analysisId: exit ? d.analysisId ?? null : d.impact?.analysisId ?? null,
      ignoredAnalysisId: d.impact?.ignoredAnalysisId ?? null,
      effect: exit ? d.effect ?? "exit_requested" : d.impact?.effect ?? "legacy_untracked",
      actual: exit ? null : { take: d.take, sizeSol: d.sizeSol, reasons: d.reasons },
      withoutAnalysis: d.impact?.withoutAnalysis ?? null, reason: d.reason ?? null, withoutExitReason: d.withoutExitReason ?? null, orders: [],
    };
  });
  const byDecision = new Map(decisions.map((d) => [d.id, d]));
  const orderRows = db.prepare(`SELECT seq, ts, mint, kind, data FROM journal WHERE kind = 'order'
    AND json_extract(data, '$.account') = 'agent'
    AND json_extract(data, '$.decisionId') IN (SELECT value FROM json_each(?)) ORDER BY seq`)
    .all(JSON.stringify([...byDecision.keys()])) as Row[];
  const byOrder = new Map<string, ResearchOrder>();
  for (const row of orderRows) {
    const o = JSON.parse(row.data);
    const order: ResearchOrder = { id: o.id, side: o.side, at: row.ts, status: "unconfirmed", reason: null, positionId: o.positionId ?? null, sol: null, closed: null };
    byOrder.set(o.id, order);
    byDecision.get(o.decisionId)?.orders.push(order);
  }
  const terminals = db.prepare(`SELECT seq, ts, mint, kind, data FROM journal WHERE kind IN ('fill', 'fill_failed', 'order_expired')
    AND json_extract(data, '$.orderId') IN (SELECT value FROM json_each(?)) ORDER BY seq`)
    .all(JSON.stringify([...byOrder.keys()])) as Row[];
  for (const row of terminals) {
    const f = JSON.parse(row.data);
    const o = byOrder.get(f.orderId)!;
    o.status = row.kind === "fill" ? "filled" : row.kind === "fill_failed" ? "failed" : "expired";
    o.reason = f.reason ?? null;
    o.positionId = f.positionId ?? o.positionId;
    o.sol = f.sol ?? null;
  }
  const closes = db.prepare(`SELECT data FROM journal WHERE kind = 'close'
    AND json_extract(data, '$.id') IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify([...byOrder.values()].map((o) => o.positionId).filter(Boolean))) as { data: string }[];
  const closed = new Map(closes.map((row) => { const c = JSON.parse(row.data); return [c.id, c]; }));
  for (const order of byOrder.values()) {
    const c = closed.get(order.positionId);
    if (c) order.closed = { at: c.closedAt, pnlSol: c.pnlSol, reason: c.exitReason };
  }
  return {
    now, since, mint: mint ?? null, limits, relatedAnalyses: extra.length,
    truncated: { analyses: ar.length > limits.analyses, decisions: dr.length > limits.decisions, errors: er.length > limits.errors },
    analyses, decisions,
    errors: er.slice(0, limits.errors).map((row) => { const e = JSON.parse(row.data); return {
      id: `error-${row.seq}`, at: row.ts, mint: row.mint, symbol: e.symbol ?? symbols.get(row.mint) ?? row.mint.slice(0, 8), error: e.error, research: e.research ?? null,
    }; }),
  };
}
