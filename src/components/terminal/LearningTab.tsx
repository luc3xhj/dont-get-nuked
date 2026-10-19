"use client";

// Learning: lessons → hypotheses → experiments → reviews, with every version kept (including failed
// ones). A model may only PROPOSE a hypothesis; activation is never automatic.
import { useState } from "react";
import { Chip, Pill, type Tone } from "./ui";
import { SETUP_LABEL } from "@/lib/agent";
import { fmtAge } from "@/lib/format";
import { usePolling } from "@/lib/hooks";

type Review = {
  at: number;
  label: string;
  stats: {
    trades: number;
    netPnlSol: number;
    avgPnlSol: number;
    avgR: number | null;
    winRate: number | null;
    comparatorTrades: number;
    comparatorAvgPnlSol: number | null;
    perTradeDiff: { diff: number; ci90: [number, number] } | null;
    tradingDays: number;
  };
};
type Report = {
  lessons: { id: string; source: string; url: string | null; claim: string; status: string; available_at: number; self_reported: number }[];
  hypotheses: { id: string; title: string; mechanism: string; trigger: string; invalidation: string; benchmark: string; status: string; proposed_by: string; created_at: number }[];
  experiments: { id: string; hypothesis_id: string; account: string; setup: string | null; comparator: string; strategy_version: string; status: string; latestReview: Review | null }[];
  cohorts: { version: number; selectedAt: number; ruleHash: string; size: number }[];
};

const LABEL_TONE: Record<string, Tone> = {
  instrumented: "idle",
  provisional: "warn",
  "supported within observed conditions": "ok",
  contradicted: "bad",
};
const sol = (v: number | null | undefined, d = 4) => (v === null || v === undefined ? "–" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}◎`);

function LessonForm({ onDone }: { onDone: () => void }) {
  const [source, setSource] = useState("");
  const [url, setUrl] = useState("");
  const [claim, setClaim] = useState("");
  const [extract, setExtract] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const input = "w-full rounded-md border border-line bg-ink px-2 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-violet-500 focus:outline-none";
  return (
    <form
      className="grid gap-1.5 rounded-lg border border-line bg-panel-2/40 p-2.5"
      onSubmit={async (e) => {
        e.preventDefault();
        const res = await fetch("/api/agent/learning/lessons", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ source, url, claim, extract }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) setMsg(json.error ?? "Could not save");
        else {
          setMsg("Saved. A hypothesis will be proposed (it stays inactive until you register it).");
          setSource("");
          setUrl("");
          setClaim("");
          setExtract("");
          onDone();
        }
      }}
    >
      <div className="grid gap-1.5 sm:grid-cols-2">
        <input className={input} placeholder="Source (e.g. trader interview)" value={source} onChange={(e) => setSource(e.target.value)} required />
        <input className={input} placeholder="URL (optional)" value={url} onChange={(e) => setUrl(e.target.value)} />
      </div>
      <input className={input} placeholder="The claim, in one sentence" value={claim} onChange={(e) => setClaim(e.target.value)} required />
      <textarea className={`${input} h-16`} placeholder="Supporting extract (optional)" value={extract} onChange={(e) => setExtract(e.target.value)} />
      <div className="flex items-center gap-2">
        <button className="rounded-md bg-violet-500/90 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500">Add lesson</button>
        {msg && <span className="text-[11px] text-zinc-400">{msg}</span>}
      </div>
    </form>
  );
}

export default function LearningTab() {
  const [v, setV] = useState(0);
  const { data, error } = usePolling<Report>(`/api/agent/learning?v=${v}`, 20_000);
  if (!data) return <div className="p-4 text-xs text-zinc-500">{error ?? "Loading learning registry…"}</div>;
  const hyp = new Map(data.hypotheses.map((h) => [h.id, h]));
  return (
    <div className="grid items-start gap-4 p-3 xl:grid-cols-[1.5fr_1fr]">
      <section>
        <div className="mb-1 flex items-baseline gap-2">
          <span className="label">Experiments</span>
          <span className="text-[11px] text-zinc-500">
            Net results per trade against the declared comparator, with a 90% interval that treats trades on the same day as dependent. Labels: instrumented → provisional →
            supported within observed conditions (or contradicted).
          </span>
        </div>
        <div className="space-y-1.5">
          {data.experiments.map((e) => {
            const r = e.latestReview;
            const h = hyp.get(e.hypothesis_id);
            return (
              <div key={e.id} className={`rounded-md border border-line px-2.5 py-2 text-xs ${e.status !== "running" ? "opacity-60" : ""}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone={r ? (LABEL_TONE[r.label] ?? "idle") : "idle"}>{r?.label ?? "not reviewed"}</Pill>
                  <span className="font-medium text-zinc-100">{h?.title ?? e.hypothesis_id}</span>
                  <span className="ml-auto text-zinc-600">
                    {e.status} · {e.strategy_version}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <Chip label="account" value={e.account} />
                  {e.setup && <Chip label="setup" value={SETUP_LABEL[e.setup] ?? e.setup} />}
                  <Chip label="vs" value={e.comparator} />
                  {r && (
                    <>
                      <Chip label="trades" value={r.stats.trades} />
                      <Chip label="days" value={r.stats.tradingDays} />
                      <Chip label="net" value={sol(r.stats.netPnlSol, 3)} tone={r.stats.netPnlSol >= 0 ? "ok" : "bad"} />
                      <Chip label="per trade" value={sol(r.stats.avgPnlSol)} />
                      <Chip label="comparator" value={sol(r.stats.comparatorAvgPnlSol)} />
                      {r.stats.perTradeDiff && (
                        <Chip label="diff 90%" value={`${sol(r.stats.perTradeDiff.ci90[0])} … ${sol(r.stats.perTradeDiff.ci90[1])}`} />
                      )}
                    </>
                  )}
                </div>
                {h && <div className="mt-1 text-zinc-500">Fails if: {h.invalidation}</div>}
              </div>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <div className="label mb-1">Add a process lesson</div>
          <LessonForm onDone={() => setV((x) => x + 1)} />
        </div>
        <div>
          <div className="label mb-1">Hypotheses</div>
          {data.hypotheses.map((h) => (
            <div key={h.id} className="mb-1.5 text-xs">
              <div className="flex items-center gap-2">
                <Pill tone={h.status === "registered" ? "info" : h.status === "proposed" ? "warn" : "idle"}>{h.status}</Pill>
                <span className="text-zinc-200">{h.title}</span>
              </div>
              <div className="text-zinc-500">
                {h.proposed_by === "model" ? "Proposed by the analyst from a lesson; inactive until registered. " : ""}Trigger: {h.trigger}
              </div>
            </div>
          ))}
        </div>
        <div>
          <div className="label mb-1">Lessons</div>
          {!data.lessons.length && <p className="text-xs text-zinc-500">No lessons yet.</p>}
          {data.lessons.map((l) => (
            <div key={l.id} className="mb-1 text-xs text-zinc-300">
              “{l.claim}” <span className="text-zinc-500">— {l.source}{l.self_reported ? " (self-reported)" : ""} · {l.status.replace(/_/g, " ")} · {fmtAge(l.available_at)} ago</span>
            </div>
          ))}
        </div>
        <div>
          <div className="label mb-1">Wallet cohort versions</div>
          {data.cohorts.slice(0, 6).map((c) => (
            <div key={c.version} className="flex gap-2 text-xs text-zinc-400">
              <span className="num">v{c.version}</span>
              <span>{c.size} wallets</span>
              <span className="text-zinc-600">selected {fmtAge(c.selectedAt)} ago · rule {c.ruleHash}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
