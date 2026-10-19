"use client";

// The decision funnel: where candidates stop between discovery and a fill, why, and which stops were
// technical failures rather than strategy.
import { EFFECT } from "../research/ResearchCards";
import { Chip, Metric, Pill, type Tone } from "./ui";
import { SETUP_LABEL, type FunnelCandidate, type FunnelReport } from "@/lib/agent";
import { fmtAge } from "@/lib/format";
import { usePolling } from "@/lib/hooks";

const STAGE_TONE: Record<FunnelCandidate["stage"], Tone> = { armed: "info", fired: "live", blocked: "warn", passed: "ok" };

function actionTone(a: string): Tone {
  if (a.startsWith("Abandon")) return "bad";
  if (a.startsWith("Retrying")) return "warn";
  if (a.startsWith("Entered")) return "ok";
  return "idle";
}

export default function Funnel({ onSelect }: { onSelect: (mint: string) => void }) {
  const { data, error } = usePolling<FunnelReport>("/api/agent/funnel?hours=6", 10_000);
  if (!data) return <div className="p-3 text-xs text-zinc-500">{error ?? "Loading funnel…"}</div>;
  const max = Math.max(1, ...data.stages.map((s) => s.n));
  const t = data.technical;
  const lookupFailures = Object.entries(t.fundingLookupFailures);
  return (
    <div className="grid gap-4 border-b border-line p-3 lg:grid-cols-[1.1fr_1fr]">
      <section>
        <div className="mb-2 flex items-baseline gap-2">
          <span className="label">Decision funnel</span>
          <span className="text-[11px] text-zinc-500">
            since {new Date(data.since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · strategy {data.version}
          </span>
        </div>
        <ol className="space-y-1">
          {data.stages.map((s, i) => {
            const prev = i ? data.stages[i - 1].n : null;
            return (
              <li key={s.id} className="grid grid-cols-[11rem_1fr_3.5rem] items-center gap-2 text-xs">
                <span className="truncate text-zinc-300">{s.label}</span>
                <div className="h-2 overflow-hidden rounded-full bg-zinc-800/80">
                  <div className="h-full rounded-full bg-violet-400/80" style={{ width: `${Math.max(s.n ? 1.5 : 0, (Math.log10(1 + s.n) / Math.log10(1 + max)) * 100)}%` }} />
                </div>
                <span className="num text-right text-zinc-200" title={prev ? `${((s.n / Math.max(1, prev)) * 100).toFixed(0)}% of the previous stage` : undefined}>
                  {s.n.toLocaleString()}
                </span>
              </li>
            );
          })}
        </ol>
        <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          <Metric
            label="Research at decision"
            value={data.researchAtDecision.decisions ? `${data.researchAtDecision.withValidReport}/${data.researchAtDecision.decisions}` : "–"}
            hint="Decisions that had a valid Codex report at the moment they were made"
          />
          <Metric label="Late research" value={t.lateAnalyses} tone={t.lateAnalyses ? "warn" : undefined} hint="Reports that arrived after the setup was gone" />
          <Metric label="Exits awaiting price" value={t.exitsWaitingForPrice} tone={t.exitsWaitingForPrice ? "warn" : undefined} />
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <div className="label mb-1">Why evaluated candidates stopped</div>
          {!data.blockers.length && <p className="text-xs text-zinc-500">No blocked decisions in this window.</p>}
          <ul className="space-y-1 text-xs">
            {data.blockers.map((b) => (
              <li key={b.id} className="flex items-center gap-2">
                <span className="num w-8 text-right text-amber-300">{b.primary}</span>
                <span className="text-zinc-300">{b.label}</span>
                {b.any > b.primary && <span className="text-[10px] text-zinc-600">(also a factor in {b.any})</span>}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="label mb-1">Technical failures (not strategy)</div>
          <div className="flex flex-wrap gap-1.5">
            <Chip label="funding reports failed" value={t.fundingReportsFailed} tone={t.fundingReportsFailed ? "bad" : undefined} />
            <Chip label="partial" value={t.fundingReportsPartial} tone={t.fundingReportsPartial ? "warn" : undefined} />
            {lookupFailures.map(([k, v]) => (
              <Chip key={k} label={k.replace(/_/g, " ")} value={v} tone="warn" />
            ))}
            <Chip label="analysis errors" value={t.analysisErrors} tone={t.analysisErrors ? "warn" : undefined} />
            <Chip label="fills failed" value={t.fillsFailed} />
            <Chip label="orders expired" value={t.ordersExpired} />
          </div>
        </div>
        {Object.keys(data.researchEffects).length > 0 && (
          <div>
            <div className="label mb-1">What research did to decisions</div>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(data.researchEffects).map(([k, v]) => (
                <Chip key={k} label={EFFECT[k as keyof typeof EFFECT] ?? k} value={v} />
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="lg:col-span-2">
        <div className="label mb-1">Live candidates</div>
        {!data.candidates.length && <p className="text-xs text-zinc-500">No setup is armed right now.</p>}
        <div className="space-y-1.5">
          {data.candidates.map((c) => (
            <button
              key={`${c.mint}:${c.setup}`}
              onClick={() => onSelect(c.mint)}
              className="grid w-full grid-cols-[auto_6rem_1fr] items-start gap-x-3 gap-y-0.5 rounded-md border border-line px-2.5 py-2 text-left text-xs hover:bg-panel-2"
            >
              <Pill tone={STAGE_TONE[c.stage]}>{c.stage}</Pill>
              <span className="truncate font-semibold text-zinc-100">{c.symbol}</span>
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-zinc-400">{SETUP_LABEL[c.setup] ?? c.setup}</span>
                <span className={actionTone(c.nextAction) === "bad" ? "text-rose-300" : actionTone(c.nextAction) === "warn" ? "text-amber-300" : "text-zinc-200"}>
                  → {c.nextAction}
                </span>
                {c.research && (
                  <span className="text-zinc-500">
                    research {c.research.verdict}
                    {c.research.validForMin > 0 ? ` (valid ${c.research.validForMin}m)` : " (expired)"}
                  </span>
                )}
                {c.decidedAt && <span className="num text-zinc-600">decided {fmtAge(c.decidedAt)} ago</span>}
              </span>
              {c.primaryBlocker && <span className="col-span-3 pl-0.5 leading-snug text-zinc-500 sm:col-start-3">{c.primaryBlocker}</span>}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
