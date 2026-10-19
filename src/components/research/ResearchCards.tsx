"use client";

// Research → decision views (originally the /research page), shared by the terminal's
// focus panel and dock. Logic unchanged; links now open coins inside the terminal.
import Link from "next/link";
import { SETUP_LABEL } from "@/lib/agent";
import type { ResearchAnalysis, ResearchBundle, ResearchDecision } from "@/lib/research-types";
import { ACCENT, Chip, Pill, TONE_TEXT, type Tone } from "../terminal/ui";

export const EFFECT: Record<ResearchDecision["effect"], string> = {
  blocked_entry: "Entry blocked by analysis",
  enabled_entry: "Sizing cleared minimum",
  resized_entry: "Entry size changed",
  unchanged: "Decision unchanged",
  other_gates: "Other gates also blocked entry",
  requirement_satisfied: "Research met a requirement; other checks still block",
  no_analysis: "No analysis available",
  expired_analysis: "Expired analysis ignored",
  exit_requested: "Exit triggered by analysis",
  exit_unchanged: "Exit also required without analysis",
  legacy_untracked: "Legacy decision · attribution unavailable",
};
export const CHANGED = new Set(["blocked_entry", "enabled_entry", "resized_entry", "exit_requested"]);
export const time = (at: number) =>
  new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const short = (id: string) => id.slice(0, 8);
export const coinHref = (mint: string) => `/?coin=${mint}`;

export function Evidence({ research, cited = [] }: { research: ResearchBundle; cited?: string[] }) {
  return (
    <div className="space-y-4 text-xs">
      <div className="text-zinc-500">
        Collected {time(research.at)} · Search snippets and retrieved social text. A matching name or narrative does not establish contract ownership.
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {research.searches.map((q, i) => (
          <div key={i} className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-950 p-3">
            <div className="mb-1 flex justify-between gap-2">
              <span className="font-medium capitalize text-zinc-200">{q.kind}</span>
              <span className={q.status === "ok" ? "text-emerald-400" : q.status === "error" ? "text-rose-400" : "text-zinc-400"}>
                {q.status} · {q.resultUrls.length} results
              </span>
            </div>
            <div className="break-words text-zinc-300">{q.query}</div>
            <div className="mt-1 text-zinc-500">{q.purpose}</div>
            {q.error && <p className="mt-2 text-amber-400">{q.error}</p>}
            <div className="mt-2 break-all text-zinc-500">
              {q.costMicro === null ? "Cost not reported" : `Reported cost: $${(q.costMicro / 1_000_000).toFixed(6)}`} · Call {q.callId ?? "not recorded"}
            </div>
          </div>
        ))}
      </div>
      <div className="font-medium text-zinc-300">Retrieved sources ({research.sources.length})</div>
      {!research.sources.length && <p className="text-zinc-500">No external source content retrieved. This is missing evidence, not evidence of fraud.</p>}
      {research.sources.map((s) => (
        <div key={s.url} className="border-l-2 border-zinc-700 pl-3">
          <a href={s.url} target="_blank" rel="noopener noreferrer" className="break-words text-violet-300 hover:underline">
            {s.title || s.url} ↗
          </a>
          <div className="my-1 flex flex-wrap gap-2 text-[11px]">
            <span className={s.mentionsContract ? "text-amber-300" : "text-zinc-500"}>
              {s.mentionsContract ? "Exact contract mentioned · ownership unverified" : "Context only · no exact contract mention"}
            </span>
            <span className="text-zinc-500">
              {s.via === "linked_social" ? "Retrieved social text" : "Search snippet"}
              {s.queryKinds.length ? ` · ${s.queryKinds.join(", ")}` : ""}
            </span>
            {cited.includes(s.url) && <span className="text-violet-300">Cited by Codex</span>}
          </div>
          <p className="whitespace-pre-wrap break-words text-zinc-400">{s.snippet || "No snippet text returned."}</p>
          <div className="mt-1 break-all text-[10px] text-zinc-600">{s.url}</div>
        </div>
      ))}
    </div>
  );
}

const verdictTone = (v: ResearchAnalysis["verdict"]): Tone => (v === "reject" ? "bad" : v === "approve" ? "ok" : "warn");

function Outcome({ label, o, highlight }: { label: string; o: ResearchDecision["actual"]; highlight: boolean }) {
  return (
    <div className={`rounded-md border p-2.5 ${highlight ? "border-violet-800/60 bg-violet-500/[0.04]" : "border-line bg-white/[0.02]"}`}>
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      {o ? (
        <>
          <div className="mt-1 flex items-center gap-2">
            <Pill tone={o.take ? "ok" : "idle"}>{o.take ? "Enter" : "Skip"}</Pill>
            <span className="num text-zinc-200">{o.sizeSol.toFixed(4)}◎</span>
          </div>
          {o.reasons.length ? (
            <ul className="mt-1.5 space-y-0.5">
              {o.reasons.map((r) => (
                <li key={r} className="flex gap-1.5 leading-snug text-zinc-400">
                  <span className="text-amber-400">✕</span>
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1.5 text-emerald-300/80">All entry gates passed</p>
          )}
        </>
      ) : (
        <p className="mt-1 text-zinc-500">Not recorded</p>
      )}
    </div>
  );
}

export function DecisionCard({ d }: { d: ResearchDecision }) {
  const changed = CHANGED.has(d.effect);
  return (
    <article id={`decision-${d.id}`} className={`scroll-mt-28 rounded-lg border border-l-2 border-line bg-panel p-3 text-xs ${ACCENT[changed ? "info" : "idle"]}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Link href={coinHref(d.mint)} className="text-[13px] font-semibold text-zinc-100 hover:text-violet-300">
          {d.symbol}
        </Link>
        <span className="text-zinc-400">{d.kind === "exit" ? "Exit" : (SETUP_LABEL[d.setup] ?? d.setup)}</span>
        <span className="ml-auto text-zinc-500">{time(d.at)}</span>
      </div>
      <div className="mt-2">
        <Pill tone={changed ? "info" : "idle"}>{EFFECT[d.effect]}</Pill>
      </div>
      {d.actual && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <Outcome label="Without analysis" o={d.withoutAnalysis} highlight={false} />
          <Outcome label="Actual decision" o={d.actual} highlight={changed} />
        </div>
      )}
      {d.kind === "exit" && (
        <p className="mt-2 text-zinc-400">
          Without analysis: {d.withoutExitReason ? `exit (${d.withoutExitReason})` : "hold at this evaluation"}. Actual decision: exit ({d.reason}).
        </p>
      )}
      {!d.orders.length && <p className="mt-2 text-zinc-500">{d.actual?.take ? "Entry accepted; no linked order recorded." : "No order placed."}</p>}
      {d.orders.map((o) => (
        <div key={o.id} className="mt-2 rounded-md bg-white/[0.025] p-2 text-zinc-400">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={o.status === "filled" ? "ok" : "warn"}>
              Paper {o.side} · {o.status === "unconfirmed" ? "no fill recorded" : o.status}
            </Pill>
            {o.sol !== null && <span className="num text-zinc-200">{o.sol.toFixed(4)}◎</span>}
            {o.reason && <span>{o.reason}</span>}
          </div>
          {o.closed && (
            <p className="mt-1">
              Position closed: {o.closed.reason} ·{" "}
              <span className={o.closed.pnlSol >= 0 ? "text-emerald-300" : "text-rose-300"}>
                {o.closed.pnlSol >= 0 ? "+" : ""}
                {o.closed.pnlSol.toFixed(4)}◎
              </span>{" "}
              (position outcome, not profit attributable to research)
            </p>
          )}
          <div className="mt-1 text-[10px] text-zinc-600">
            Order {short(o.id)}
            {o.positionId && ` · Position ${short(o.positionId)}`}
          </div>
        </div>
      ))}
      <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-zinc-600">
        <span>Decision {short(d.id)}</span>
        {(d.analysisId || d.ignoredAnalysisId) && (
          <a href={`#analysis-${d.analysisId ?? d.ignoredAnalysisId}`} className="text-violet-400 hover:underline">
            {d.ignoredAnalysisId ? "Ignored report" : "Report"} {short((d.analysisId ?? d.ignoredAnalysisId)!)}
          </a>
        )}
      </div>
    </article>
  );
}

export function AnalysisCard({ a, decisions, now }: { a: ResearchAnalysis; decisions: ResearchDecision[]; now: number }) {
  const used = decisions.filter((d) => d.analysisId === a.id);
  const expired = decisions.filter((d) => d.ignoredAnalysisId === a.id);
  const changed = used.filter((d) => CHANGED.has(d.effect));
  const tone = verdictTone(a.verdict);
  const valid = a.expiresAt > now;
  return (
    <article id={`analysis-${a.id}`} className={`scroll-mt-28 rounded-lg border border-l-2 border-line bg-panel p-3 ${ACCENT[tone]}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={tone} size="md">
          {a.verdict} ×{a.conviction.toFixed(2)}
        </Pill>
        <Link href={coinHref(a.mint)} className="text-[13px] font-semibold text-zinc-100 hover:text-violet-300">
          {a.symbol}
        </Link>
        <span className="truncate text-xs text-zinc-500">{a.name}</span>
        <span className={`ml-auto text-[11px] ${valid ? "text-zinc-400" : "text-zinc-600"}`}>
          {time(a.at)} · {valid ? `valid until ${time(a.expiresAt)}` : "expired"}
        </span>
      </div>
      <p className="mt-2.5 text-[13px] leading-snug text-zinc-100">{a.narrative}</p>
      <p className="mt-1 text-xs leading-relaxed text-zinc-400">{a.thesis}</p>
      {(a.redFlags.length > 0 || a.greenFlags.length > 0) && (
        <div className="mt-2.5 grid gap-2 text-xs sm:grid-cols-2">
          {[
            { title: "Against", items: a.redFlags, t: "bad" as Tone, sign: "−" },
            { title: "For", items: a.greenFlags, t: "ok" as Tone, sign: "+" },
          ]
            .filter((g) => g.items.length)
            .map((g) => (
              <div key={g.title}>
                <div className={`mb-0.5 text-[10px] font-semibold uppercase tracking-wide ${TONE_TEXT[g.t]}`}>{g.title}</div>
                <ul className="space-y-0.5">
                  {g.items.slice(0, 3).map((x, i) => (
                    <li key={i} className="flex gap-1.5 leading-snug text-zinc-300">
                      <span className={TONE_TEXT[g.t]}>{g.sign}</span>
                      <span>{x}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </div>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs">
        <Chip label="used by" value={`${used.length} decision${used.length === 1 ? "" : "s"}`} />
        <Chip label="changed" value={changed.length} tone={changed.length ? "info" : undefined} />
        {expired.length > 0 && <Chip label="ignored (expired)" value={expired.length} tone="idle" />}
        {used.map((d) => (
          <a key={d.id} href={`#decision-${d.id}`} className="text-[11px] text-violet-400 hover:underline">
            {EFFECT[d.effect]} ↗
          </a>
        ))}
      </div>
      <details className="mt-3 text-xs">
        <summary className="cursor-pointer text-zinc-400 hover:text-zinc-200">
          Evidence · {a.research?.searches.length ?? 0} searches · {a.research?.sources.length ?? 0} sources
        </summary>
        <div className="mt-3 space-y-3">
          <p className="text-zinc-500">Contract association verdict: {a.contractVerified}. An exact mention alone does not establish official ownership.</p>
          {a.redFlags.slice(3).map((flag, i) => (
            <p key={`r${i}`} className="text-rose-400">
              − {flag}
            </p>
          ))}
          {a.greenFlags.slice(3).map((flag, i) => (
            <p key={`g${i}`} className="text-emerald-400">
              + {flag}
            </p>
          ))}
          <p className="text-zinc-400">Would change its mind: {a.wouldChangeMind}</p>
          {a.research ? (
            <Evidence research={a.research} cited={a.sources} />
          ) : (
            <p className="text-amber-400">Legacy report: query traces and retrieved content were not saved. Historical source links are not treated as verified retrievals.</p>
          )}
          <div className="break-all text-[10px] text-zinc-600">
            Analysis {a.id} · Contract {a.mint}
          </div>
        </div>
      </details>
    </article>
  );
}
