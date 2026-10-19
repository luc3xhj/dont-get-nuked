"use client";

// System: is the worker healthy, which data routes are actually usable, what research is queued,
// and do the books reconcile. Connectivity, freshness and qualification are separate fields.
import { Chip, Metric, Pill, type Tone } from "./ui";
import { fmtAge } from "@/lib/format";
import { usePolling } from "@/lib/hooks";

type Health = {
  workerState: string;
  heartbeatAt: number;
  stateRevision: number;
  schemaVersions: number[];
  recovery: { migrations: number[]; backup: string | null; restoredMints: number; missingMints: string[]; error?: string };
  reconciliation: { ok: boolean; issues: string[] };
  eventLoopDelayMs: { p50: number; p99: number; max: number };
  executionModel: string;
};
type Capability = {
  id: string;
  provider: string;
  operation: string;
  accessScope: string;
  zeroCost: string;
  stage: string;
  state: "qualified" | "degraded" | "unsupported";
  enabled: boolean;
  note: string;
  timestampSemantics: string;
  measured: Record<string, unknown>;
};
type Jobs = {
  byType: Record<string, Record<string, number>>;
  queued: number;
  queueWaitMs: { p50: number | null; p95: number | null };
  runMs: { p50: number | null; p95: number | null };
};

const STATE_TONE: Record<Capability["state"], Tone> = { qualified: "ok", degraded: "warn", unsupported: "idle" };
const sec = (ms: number | null) => (ms === null ? "–" : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 1000).toFixed(0)}s`);

export default function SystemTab() {
  const { data: h } = usePolling<Health>("/api/agent/health", 5_000);
  const { data: caps } = usePolling<Capability[]>("/api/agent/capabilities", 15_000);
  const { data: jobs } = usePolling<Jobs>("/api/agent/jobs", 15_000);
  if (!h) return <div className="p-4 text-xs text-zinc-500">Loading system status…</div>;
  const workerTone: Tone = h.workerState === "running" ? "ok" : h.workerState === "faulted" ? "bad" : "warn";
  return (
    <div className="grid items-start gap-4 p-3 xl:grid-cols-[1fr_1.4fr]">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="label">Worker</span>
          <Pill tone={workerTone}>{h.workerState}</Pill>
          <Pill tone={h.reconciliation.ok ? "ok" : "bad"}>{h.reconciliation.ok ? "books reconcile" : "reconciliation gap"}</Pill>
          <span className="text-[11px] text-zinc-500">heartbeat {fmtAge(h.heartbeatAt)} ago · revision {h.stateRevision}</span>
        </div>
        {!h.reconciliation.ok && (
          <ul className="space-y-0.5 text-xs text-rose-300">
            {h.reconciliation.issues.map((i) => (
              <li key={i}>✕ {i}</li>
            ))}
          </ul>
        )}
        <div className="grid grid-cols-3 gap-1.5">
          <Metric label="Event loop p99" value={`${h.eventLoopDelayMs.p99.toFixed(0)} ms`} tone={h.eventLoopDelayMs.p99 > 200 ? "warn" : undefined} />
          <Metric label="Schema" value={`v${Math.max(0, ...h.schemaVersions)}`} hint={`Applied: ${h.schemaVersions.join(", ")}`} />
          <Metric label="Recovered markets" value={h.recovery.restoredMints} tone={h.recovery.missingMints.length ? "warn" : undefined} hint={h.recovery.missingMints.join(", ")} />
        </div>
        <p className="text-[11px] leading-snug text-zinc-500">Execution model: {h.executionModel}</p>
        {jobs && (
          <div>
            <div className="label mb-1">Research jobs (24h)</div>
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              <Chip label="queued" value={jobs.queued} />
              <Chip label="wait p50" value={sec(jobs.queueWaitMs.p50)} />
              <Chip label="wait p95" value={sec(jobs.queueWaitMs.p95)} />
              <Chip label="run p50" value={sec(jobs.runMs.p50)} />
            </div>
            {Object.entries(jobs.byType).map(([type, st]) => (
              <div key={type} className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="w-36 text-zinc-300">{type.replace(/_/g, " ")}</span>
                {Object.entries(st).map(([k, v]) => (
                  <Chip key={k} label={k} value={v} tone={k === "failed" || k === "expired" ? "warn" : k === "done" ? "ok" : undefined} />
                ))}
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="mb-1 flex items-baseline gap-2">
          <span className="label">Data capabilities</span>
          <span className="text-[11px] text-zinc-500">A route is qualified only if it is enabled, verified zero-cost and live-checked. Paid and unverified routes are refused.</span>
        </div>
        <div className="space-y-1.5">
          {(caps ?? []).map((c) => (
            <div key={c.id} className="rounded-md border border-line px-2.5 py-1.5 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={STATE_TONE[c.state]}>{c.state}</Pill>
                <span className="font-medium text-zinc-100">{c.provider}</span>
                <span className="text-zinc-400">{c.operation}</span>
                <span className="ml-auto flex gap-1">
                  <Chip value={c.zeroCost.replace(/_/g, " ")} tone={c.zeroCost === "verified_free" ? "ok" : c.zeroCost === "paid" ? "bad" : "warn"} />
                  <Chip value={c.stage.replace(/_/g, " ")} tone={c.stage === "live_checked" ? "ok" : "idle"} />
                </span>
              </div>
              <div className="mt-0.5 text-zinc-500">
                {c.note} <span className="text-zinc-600">· time: {c.timestampSemantics}</span>
              </div>
              {Object.keys(c.measured).length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {Object.entries(c.measured)
                    .filter(([, v]) => typeof v === "number" || typeof v === "boolean")
                    .map(([k, v]) => (
                      <Chip key={k} label={k} value={typeof v === "boolean" ? (v ? "yes" : "no") : k.endsWith("At") ? `${fmtAge(v as number)} ago` : String(v)} />
                    ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
