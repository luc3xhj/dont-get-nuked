"use client";

import { pnlColor } from "@/lib/format";
import { usePolling } from "@/lib/hooks";

type Stat = { n: number; winRate: number; avgR: number };
type Evidence = {
  trades: number;
  joined: number;
  minN: number;
  edge: { setups: Stat; random: Stat; diffCi90: [number, number] | null; verdict: string };
  screens: { id: string; levels: Partial<Record<"ok" | "warn" | "veto" | "unknown", Stat>> }[];
  features: { key: string; label: string; n: number; buckets: (Stat & { lo: number; hi: number })[] }[];
  recommendations: string[];
};

const cell = (s?: Stat, min = 1) =>
  s && s.n >= min ? (
    <span className="num">
      <span className={pnlColor(s.avgR)}>{s.avgR.toFixed(2)}R</span> <span className="text-zinc-600">n{s.n}</span>
    </span>
  ) : (
    <span className="text-zinc-700">–</span>
  );

const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(2));

/** What the screens and features said at entry vs how benchmark trades turned out. */
export default function EvidencePanel() {
  const { data: e } = usePolling<Evidence>("/api/agent/evidence", 30_000);
  if (!e) return <div className="p-4 text-sm text-zinc-500">Loading…</div>;
  const ci = e.edge.diffCi90;
  return (
    <div className="space-y-4 p-4 text-xs">
      <div className="rounded-lg border border-zinc-800 p-3">
        <div className="text-sm font-semibold text-white">{e.edge.verdict}</div>
        <div className="num mt-1 text-zinc-500">
          setups {e.edge.setups.avgR.toFixed(2)}R over {e.edge.setups.n} · random coins {e.edge.random.avgR.toFixed(2)}R over {e.edge.random.n}
          {ci && ` · difference 90% interval ${ci[0].toFixed(2)} to ${ci[1].toFixed(2)}R`}
        </div>
      </div>

      <ul className="space-y-1 text-zinc-300">
        {e.recommendations.map((r) => (
          <li key={r}>• {r}</li>
        ))}
      </ul>

      <div className="grid gap-4 xl:grid-cols-2">
        <table className="w-full">
          <thead className="text-zinc-500">
            <tr className="text-left">
              <th className="py-1 font-medium">Screen at entry</th>
              <th className="py-1 font-medium">ok</th>
              <th className="py-1 font-medium">warn</th>
              <th className="py-1 font-medium">veto</th>
            </tr>
          </thead>
          <tbody>
            {e.screens.map((s) => (
              <tr key={s.id} className="border-t border-zinc-900">
                <td className="py-1 text-zinc-300">{s.id}</td>
                <td className="py-1">{cell(s.levels.ok)}</td>
                <td className="py-1">{cell(s.levels.warn)}</td>
                <td className="py-1">{cell(s.levels.veto)}</td>
              </tr>
            ))}
            {!e.screens.length && (
              <tr>
                <td colSpan={4} className="py-2 text-zinc-600">
                  No benchmark trades with recorded screens yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <table className="w-full">
          <thead className="text-zinc-500">
            <tr className="text-left">
              <th className="py-1 font-medium">Feature at entry</th>
              <th className="py-1 font-medium">low third</th>
              <th className="py-1 font-medium">middle</th>
              <th className="py-1 font-medium">high third</th>
            </tr>
          </thead>
          <tbody>
            {e.features.map((f) => (
              <tr key={f.key} className="border-t border-zinc-900">
                <td className="py-1 text-zinc-300">{f.label}</td>
                {f.buckets.length ? (
                  f.buckets.map((b, i) => (
                    <td key={i} className="py-1" title={`${fmt(b.lo)} – ${fmt(b.hi)}`}>
                      {cell(b)}
                    </td>
                  ))
                ) : (
                  <td colSpan={3} className="py-1 text-zinc-700">
                    needs 9+ trades (has {f.n})
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-zinc-600">
        Every-setup benchmark trades, joined to what the agent saw when the setup fired ({e.joined} of {e.trades} matched). Nothing here changes the agent
        automatically; recommendations appear once each side of a comparison has {e.minN}+ trades.
      </p>
    </div>
  );
}
