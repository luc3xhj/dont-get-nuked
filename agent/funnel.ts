// The decision funnel (roadmap phase 4): where candidates stop on the way from discovery to a fill,
// why they stop, and which stops were technical failures rather than strategy. It separates a
// selective strategy from a broken pipeline.
import { CONFIG } from "./config";
import { db } from "./db";
import { coins, pinned } from "./state";

export type BlockerCategory =
  | "economics"
  | "missing_evidence"
  | "screens"
  | "research"
  | "portfolio"
  | "risk_pause"
  | "regime"
  | "size"
  | "no_edge"
  | "other";

const BLOCKER_LABEL: Record<BlockerCategory, string> = {
  economics: "Trade economics (reward/risk after costs)",
  missing_evidence: "Missing or incomplete evidence",
  screens: "Risk screens (veto or too many warnings)",
  research: "Research rejected",
  portfolio: "Portfolio limits (open positions, same developer, cooldown)",
  risk_pause: "Account risk pause",
  regime: "Market regime",
  size: "Order below the minimum size",
  no_edge: "No measured edge for this setup",
  other: "Other",
};

export function categorize(reason: string): BlockerCategory {
  if (/reward\/risk|better entry|Targets can't pay|doesn't cover costs/i.test(reason)) return "economics";
  if (/Missing essential evidence/i.test(reason)) return "missing_evidence";
  if (/Screen veto|screen warnings/i.test(reason)) return "screens";
  if (/Analyst rejected/i.test(reason)) return "research";
  if (/positions open|Already|Re-entry|developer's coins/i.test(reason)) return "portfolio";
  if (/drawdown|Daily loss|Cooling down|Paused/i.test(reason)) return "risk_pause";
  if (/regime/i.test(reason)) return "regime";
  if (/below minimum/i.test(reason)) return "size";
  if (/No edge/i.test(reason)) return "no_edge";
  return "other";
}

/** What the candidate is waiting for, in words, from its blocking reasons. */
function nextAction(reasons: string[]): string {
  const r = reasons.join(" | ");
  const limit = r.match(/better entry ≤ ([\d.e-]+)◎ \(([\d.]+)% lower\)/);
  if (limit) return `Waiting for price: entry ≤ ${limit[1]}◎ (${limit[2]}% lower)`;
  if (/Targets can't pay/.test(r)) return "Abandon: no valid entry pays for the stop";
  if (/lookup.*failed; retry scheduled/.test(r)) return "Retrying failed wallet lookups";
  if (/Missing essential evidence/.test(r)) return `Collecting data: ${r.match(/Missing essential evidence: ([^(;]+)/)?.[1]?.trim() ?? "required evidence"}`;
  if (/positions open|developer's coins|Re-entry/.test(r)) return "Waiting for a portfolio slot";
  if (/Screen veto|Analyst rejected/.test(r)) return "Abandon: adverse evidence";
  if (/regime|Cooling|drawdown|Daily loss|Paused/i.test(r)) return "Waiting for trading to resume";
  return reasons.length ? "Blocked" : "Entered";
}

db.exec("CREATE TABLE IF NOT EXISTS strategy_versions (version TEXT PRIMARY KEY, started_at INTEGER NOT NULL)");
/** Records when a strategy version first ran, so its funnel never mixes in an older version's activity. */
export function markVersionStart(version = CONFIG.strategyVersion, now = Date.now()) {
  db.prepare("INSERT OR IGNORE INTO strategy_versions (version, started_at) VALUES (?, ?)").run(version, now);
}
const versionStart = (version: string) =>
  (db.prepare("SELECT started_at FROM strategy_versions WHERE version = ?").get(version) as { started_at: number } | undefined)?.started_at ?? 0;

const one = (sql: string, ...args: (number | string)[]) => Object.values(db.prepare(sql).get(...args) as Record<string, number>)[0] ?? 0;

export function funnelReport(hours = 6, version = CONFIG.strategyVersion, now = Date.now()) {
  const since = Math.max(now - hours * 3600_000, versionStart(version));
  const decisions = db
    .prepare("SELECT at, mint, json_extract(snapshot, '$.setup') AS setup, result FROM decisions WHERE at >= ? AND version = ? ORDER BY at DESC")
    .all(since, version) as { at: number; mint: string; setup: string; result: string }[];
  const parsed = decisions.map((d) => ({ ...d, r: JSON.parse(d.result) as { take: boolean; reasons: string[]; impact?: { effect: string } } }));
  const stages = [
    { id: "discovered", label: "Discovered", n: one("SELECT COUNT(*) FROM coins WHERE updated_at >= ?", since) },
    { id: "data_ready", label: "Passed list filters (deep-watched)", n: one("SELECT COUNT(DISTINCT mint) FROM journal WHERE kind = 'hot' AND ts >= ?", since) },
    { id: "armed", label: "Setup armed", n: one("SELECT COUNT(*) FROM setup_episodes WHERE armed_at >= ?", since) },
    {
      id: "fired",
      label: "Trigger fired",
      n: one("SELECT COUNT(*) FROM setup_episodes WHERE armed_at >= ? AND json_extract(data, '$.firedAt') IS NOT NULL", since),
    },
    { id: "decided", label: "Evaluated by the agent", n: new Set(parsed.map((d) => `${d.mint}:${d.setup}`)).size },
    { id: "passed", label: "Risk and economics passed", n: new Set(parsed.filter((d) => d.r.take).map((d) => `${d.mint}:${d.setup}`)).size },
    {
      id: "ordered",
      label: "Order submitted",
      n: one("SELECT COUNT(*) FROM journal WHERE kind = 'order' AND ts >= ? AND json_extract(data, '$.account') = 'agent' AND json_extract(data, '$.side') = 'buy'", since),
    },
    {
      id: "filled",
      label: "Filled",
      n: one("SELECT COUNT(*) FROM journal WHERE kind = 'fill' AND ts >= ? AND json_extract(data, '$.account') = 'agent' AND json_extract(data, '$.side') = 'buy'", since),
    },
  ];

  // Why evaluated candidates were blocked: primary (first) reason, and every reason.
  const primary: Partial<Record<BlockerCategory, number>> = {};
  const any: Partial<Record<BlockerCategory, number>> = {};
  for (const d of parsed.filter((x) => !x.r.take)) {
    const cats = d.r.reasons.map(categorize);
    if (cats[0]) primary[cats[0]] = (primary[cats[0]] ?? 0) + 1;
    for (const c of new Set(cats)) any[c] = (any[c] ?? 0) + 1;
  }
  const effects: Record<string, number> = {};
  for (const d of parsed) if (d.r.impact) effects[d.r.impact.effect] = (effects[d.r.impact.effect] ?? 0) + 1;

  // Technical failures, kept apart from strategy rejections.
  const count = (kind: string) => one("SELECT COUNT(*) FROM journal WHERE kind = ? AND ts >= ?", kind, since);
  const fundingFailures: Record<string, number> = {};
  for (const r of db.prepare("SELECT data FROM journal WHERE kind = 'funding_partial' AND ts >= ?").all(since) as { data: string }[])
    for (const [k, v] of Object.entries((JSON.parse(r.data).failureCounts ?? {}) as Record<string, number>)) fundingFailures[k] = (fundingFailures[k] ?? 0) + v;
  const technical = {
    fundingReportsFailed: count("funding_error"),
    fundingReportsPartial: count("funding_partial"),
    fundingLookupFailures: fundingFailures,
    analysisErrors: count("analysis_error"),
    lateAnalyses: one("SELECT COUNT(*) FROM journal WHERE kind = 'analysis' AND ts >= ? AND json_extract(data, '$.timing') = 'late'", since),
    fillsFailed: count("fill_failed"),
    ordersExpired: count("order_expired"),
    exitsWaitingForPrice: count("exit_waiting"),
  };

  // Live candidates: every coin with an armed or firing setup, its latest decision and next action.
  const latest = new Map<string, (typeof parsed)[number]>();
  for (const d of parsed) if (!latest.has(`${d.mint}:${d.setup}`)) latest.set(`${d.mint}:${d.setup}`, d);
  const candidates = [...coins.values()]
    .filter((s) => s.setups.length)
    .flatMap((s) =>
      s.setups.map((x) => {
        const d = latest.get(`${s.coin.mint}:${x.setup}`);
        const recent = d && d.at >= (x.episode?.armedAt ?? 0);
        const waitingOn = x.trigger.filter((k) => !k.ok).map((k) => k.label);
        const reasons = recent ? d.r.reasons : [];
        return {
          mint: s.coin.mint,
          symbol: s.coin.symbol,
          setup: x.setup,
          stage: recent ? (d.r.take ? "passed" : "blocked") : x.status === "fire" ? "fired" : "armed",
          episode: x.episode ?? null,
          held: pinned.has(s.coin.mint),
          waitingOn,
          primaryBlocker: reasons[0] ?? null,
          blockers: reasons,
          blockerCategory: reasons[0] ? categorize(reasons[0]) : null,
          nextAction: recent ? nextAction(reasons) : waitingOn.length ? `Waiting for trigger: ${waitingOn[0]}` : "Trigger met; decision pending",
          research: s.analysis
            ? { verdict: s.analysis.verdict, validForMin: Math.round((s.analysis.expiresAt - now) / 60_000), effect: recent ? (d.r.impact?.effect ?? null) : null }
            : null,
          decidedAt: recent ? d.at : null,
        };
      }),
    )
    .sort((a, b) => (a.stage === b.stage ? 0 : a.stage === "blocked" ? -1 : b.stage === "blocked" ? 1 : a.stage === "fired" ? -1 : 1));

  return {
    version,
    hours,
    since,
    stages,
    blockers: Object.entries(primary)
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => ({ id, label: BLOCKER_LABEL[id as BlockerCategory], primary: n, any: any[id as BlockerCategory] ?? n })),
    researchEffects: effects,
    researchAtDecision: {
      decisions: parsed.length,
      withValidReport: parsed.filter((d) => d.r.impact && !["no_analysis", "expired_analysis"].includes(d.r.impact.effect)).length,
    },
    technical,
    candidates,
  };
}
