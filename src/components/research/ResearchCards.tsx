"use client";

// Research → decision views (originally the /research page), shared by the terminal's
// focus panel and dock. Logic unchanged; links now open coins inside the terminal.
import Link from "next/link";
import { SETUP_LABEL, VERDICT_TONE } from "@/lib/agent";
import type { ResearchAnalysis, ResearchBundle, ResearchDecision } from "@/lib/research-types";

export const EFFECT: Record<ResearchDecision["effect"], string> = {
  blocked_entry: "Entry blocked by analysis",
  enabled_entry: "Sizing cleared minimum",
  resized_entry: "Entry size changed",
  unchanged: "Decision unchanged",
  other_gates: "Other gates also blocked entry",
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

export function DecisionCard({ d }: { d: ResearchDecision }) {
  return (
    <article id={`decision-${d.id}`} className="scroll-mt-28 rounded-lg border border-zinc-800 p-3 text-xs">
      <div className="flex flex-wrap justify-between gap-2">
        <Link href={coinHref(d.mint)} className="font-semibold text-zinc-200 hover:text-white">
          {d.symbol} · {d.kind === "exit" ? "Exit" : (SETUP_LABEL[d.setup] ?? d.setup)}
        </Link>
        <span className="text-zinc-500">{time(d.at)}</span>
      </div>
      <p className={`mt-2 font-medium ${CHANGED.has(d.effect) ? "text-violet-300" : "text-zinc-400"}`}>{EFFECT[d.effect]}</p>
      {d.actual && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {[
            { label: "Without analysis", o: d.withoutAnalysis },
            { label: "Actual decision", o: d.actual },
          ].map(({ label, o }) => (
            <div key={label} className="rounded bg-zinc-900/60 p-2">
              <div className="text-zinc-500">{label}</div>
              {o ? (
                <>
                  <div className="mt-1 text-zinc-200">
                    {o.take ? "Enter" : "Skip"} · proposed {o.sizeSol.toFixed(4)} SOL
                  </div>
                  <p className="mt-1 text-zinc-400">{o.reasons.join("; ") || "All entry gates passed"}</p>
                </>
              ) : (
                <p className="mt-1 text-zinc-500">Not recorded</p>
              )}
            </div>
          ))}
        </div>
      )}
      {d.kind === "exit" && (
        <p className="mt-2 text-zinc-400">
          Without analysis: {d.withoutExitReason ? `exit (${d.withoutExitReason})` : "hold at this evaluation"}. Actual decision: exit ({d.reason}).
        </p>
      )}
      {!d.orders.length && <p className="mt-2 text-zinc-500">{d.actual?.take ? "Entry accepted; no linked order recorded." : "No linked order or simulated fill."}</p>}
      {d.orders.map((o) => (
        <div key={o.id} className="mt-2 rounded bg-zinc-900 p-2 text-zinc-400">
          <span className={o.status === "filled" ? "text-emerald-400" : "text-amber-300"}>
            Paper {o.side}: {o.status === "unconfirmed" ? "submitted · no terminal event recorded" : o.status}
          </span>
          {o.sol !== null && ` · ${o.sol.toFixed(4)} SOL`}
          {o.reason && ` · ${o.reason}`}
          {o.closed && (
            <p className="mt-1">
              Position closed: {o.closed.reason} · realized {o.closed.pnlSol.toFixed(4)} SOL. This is the position outcome, not measured profit from research.
            </p>
          )}
          <div className="mt-1 text-[10px] text-zinc-600">
            Order {short(o.id)}
            {o.positionId && ` · Position ${short(o.positionId)}`}
          </div>
        </div>
      ))}
      <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-zinc-500">
        <span>Decision {short(d.id)}</span>
        {(d.analysisId || d.ignoredAnalysisId) && (
          <a href={`#analysis-${d.analysisId ?? d.ignoredAnalysisId}`} className="text-violet-400 hover:underline">
            {d.ignoredAnalysisId ? "Ignored report" : "Analysis"} {short((d.analysisId ?? d.ignoredAnalysisId)!)}
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
  return (
    <article id={`analysis-${a.id}`} className="scroll-mt-28 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <Link href={coinHref(a.mint)} className="font-semibold text-zinc-100 hover:text-violet-300">
            {a.symbol} <span className="text-xs font-normal text-zinc-500">{a.name}</span>
          </Link>
          <div className="mt-1 text-[11px] text-zinc-500">
            {time(a.at)} · {a.expiresAt > now ? `valid until ${time(a.expiresAt)}` : `expired ${time(a.expiresAt)}`}
          </div>
        </div>
        <span className={`rounded border px-2 py-1 text-xs ${VERDICT_TONE[a.verdict]}`}>
          {a.verdict} · ×{a.conviction.toFixed(2)}
        </span>
      </div>
      <p className="mt-3 text-sm text-zinc-200">{a.narrative}</p>
      <p className="mt-1 text-xs leading-relaxed text-zinc-400">{a.thesis}</p>
      <div className="mt-3 rounded-lg bg-violet-500/5 p-3 text-xs">
        <p className="text-violet-300">
          {used.length
            ? `${used.length} linked decisions · ${changed.length} changed by analysis · ${changed.flatMap((d) => d.orders).filter((o) => o.status === "filled").length} simulated fills on changed decisions`
            : "No recorded decision used this report in the displayed window."}
        </p>
        {expired.length > 0 && <p className="mt-1 text-zinc-500">Ignored after expiry in {expired.length} decisions.</p>}
        {used.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-3">
            {used.map((d) => (
              <a key={d.id} href={`#decision-${d.id}`} className="text-violet-400 hover:underline">
                {EFFECT[d.effect]} ↗
              </a>
            ))}
          </div>
        )}
      </div>
      <details className="mt-3 text-xs">
        <summary className="cursor-pointer text-zinc-300">
          Analysis details &amp; evidence · {a.research?.searches.length ?? 0} recorded searches · {a.research?.sources.length ?? 0} retrieved sources
        </summary>
        <div className="mt-3 space-y-3">
          <p className="text-zinc-500">Contract association verdict: {a.contractVerified}. An exact mention alone does not establish official ownership.</p>
          {a.greenFlags.map((flag, i) => (
            <p key={`g${i}`} className="text-emerald-400">
              + {flag}
            </p>
          ))}
          {a.redFlags.map((flag, i) => (
            <p key={`r${i}`} className="text-rose-400">
              − {flag}
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
