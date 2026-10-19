"use client";

// Discovery: candidates from three ingress routes (market, evidence, wallet), the registered topic
// sources and their health, narratives with independent-origin counts, and the latest evidence.
// A reference in a search snippet is shown as unresolved until the mint is validated on chain.
import { Chip, Pill, type Tone } from "./ui";
import { shortAddr } from "@/lib/agent";
import { fmtAge } from "@/lib/format";
import { usePolling } from "@/lib/hooks";

type Candidate = {
  id: string;
  mint: string;
  symbol: string | null;
  ingress: string[];
  identity_state: string;
  state: string;
  first_seen_at: number;
  last_event_at: number;
  hot: boolean;
  pulse: string | null;
  narrative_ids: string[];
};
type Report = {
  sources: { id: string; topic: string; locator: string; access_scope: string; zero_cost: string; enabled: number; cadence_ms: number; last_attempt_at: number | null; last_success_at: number | null; health: string }[];
  narratives: { id: string; label: string; version: number; evidence_count: number; independent_origins: number; mints: string[]; status: string; latest_evidence_at: number }[];
  candidates: Candidate[];
  counts: { state: string; n: number }[];
  ingress24h: { kind: string; n: number }[];
  evidence: { id: string; title: string; canonical_url: string | null; snippet: string; asserted_mints: string[]; received_at: number; inspection_depth: string }[];
};

const INGRESS_TONE: Record<string, Tone> = { market: "info", evidence: "warn", wallet: "live" };

export default function DiscoveryTab({ onSelect }: { onSelect: (mint: string) => void }) {
  const { data, error } = usePolling<Report>("/api/agent/discovery", 15_000);
  if (!data) return <div className="p-4 text-xs text-zinc-500">{error ?? "Loading discovery…"}</div>;
  return (
    <div className="grid items-start gap-4 p-3 xl:grid-cols-[1.3fr_1fr]">
      <section>
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
          <span className="label mr-1">Candidates</span>
          {data.counts.map((c) => (
            <Chip key={c.state} label={c.state} value={c.n} />
          ))}
          <span className="mx-1 text-zinc-700">|</span>
          {data.ingress24h.map((c) => (
            <Chip key={c.kind} label={`${c.kind} (24h)`} value={c.n} tone={INGRESS_TONE[c.kind]} />
          ))}
        </div>
        <p className="mb-2 text-[11px] text-zinc-500">
          Discovery only asks for attention: a candidate still has to pass its Pulse filters, risk screens and a strategy&apos;s contract before any trade.
        </p>
        {!data.candidates.length && <p className="text-xs text-zinc-500">No candidates yet.</p>}
        <div className="space-y-1">
          {data.candidates.map((c) => (
            <button
              key={c.id}
              onClick={() => c.identity_state === "chain_validated" && onSelect(c.mint)}
              className="flex w-full flex-wrap items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-left text-xs hover:bg-panel-2"
            >
              <span className="w-24 truncate font-semibold text-zinc-100">{c.symbol ?? shortAddr(c.mint)}</span>
              {c.ingress.map((i) => (
                <Pill key={i} tone={INGRESS_TONE[i] ?? "idle"} icon={false}>
                  {i}
                </Pill>
              ))}
              <Pill tone={c.identity_state === "chain_validated" ? "ok" : c.identity_state === "conflicted" ? "bad" : "idle"}>
                {c.identity_state === "chain_validated" ? "validated" : c.identity_state}
              </Pill>
              {c.pulse && <Chip label="pulse" value={c.pulse} tone={c.pulse === "pass" ? "ok" : c.pulse === "fail" ? "bad" : undefined} />}
              {c.hot && <Chip value="deep-watched" tone="live" />}
              <span className="num ml-auto text-zinc-600">{fmtAge(c.last_event_at)} ago</span>
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <div className="label mb-1">Registered sources</div>
          {data.sources.map((s) => (
            <div key={s.id} className="mb-1 rounded-md border border-line px-2.5 py-1.5 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-zinc-100">{s.topic}</span>
                <Chip value={s.zero_cost.replace(/_/g, " ")} tone={s.zero_cost === "verified_free" ? "ok" : "warn"} />
                <span className="ml-auto text-zinc-500">every {Math.round(s.cadence_ms / 60_000)}m</span>
              </div>
              <div className="text-zinc-500">
                “{s.locator}” · {s.access_scope}
              </div>
              <div className={s.health.startsWith("ok") ? "text-zinc-400" : "text-amber-300"}>
                {s.health}
                {s.last_success_at ? ` · last success ${fmtAge(s.last_success_at)} ago` : ""}
              </div>
            </div>
          ))}
        </div>
        <div>
          <div className="label mb-1">Narratives</div>
          {!data.narratives.length && <p className="text-xs text-zinc-500">No narrative evidence collected yet.</p>}
          {data.narratives.map((n) => (
            <div key={n.id} className="mb-1 flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-zinc-200">{n.label}</span>
              <Chip label="evidence" value={n.evidence_count} />
              <Chip label="independent origins" value={n.independent_origins} />
              <Chip label="linked mints" value={n.mints.length} />
              <span className="text-zinc-600">v{n.version}</span>
            </div>
          ))}
        </div>
        <div>
          <div className="label mb-1">Latest evidence (search snippets)</div>
          {data.evidence.slice(0, 8).map((e) => (
            <div key={e.id} className="mb-1.5 border-l-2 border-line pl-2 text-xs">
              {e.canonical_url ? (
                <a href={e.canonical_url} target="_blank" rel="noreferrer noopener" className="text-violet-300 hover:underline">
                  {e.title || e.canonical_url} ↗
                </a>
              ) : (
                <span className="text-zinc-300">{e.title}</span>
              )}
              <div className="line-clamp-2 text-zinc-500">{e.snippet}</div>
              <div className="text-[10px] text-zinc-600">
                {e.inspection_depth.replace(/_/g, " ")} · {e.asserted_mints.length} address reference{e.asserted_mints.length === 1 ? "" : "s"} · {fmtAge(e.received_at)} ago
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
