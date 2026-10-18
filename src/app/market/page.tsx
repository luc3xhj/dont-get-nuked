"use client";

import { useRouter } from "next/navigation";
import TokenIcon from "@/components/TokenIcon";
import {
  coinImage,
  LANE_LABEL,
  LANE_TONE,
  REGIME_TONE,
  SCREEN_TONE,
  SETUP_LABEL,
  VERDICT_TONE,
  type AgentState,
  type Cohort,
  type Flow,
  type WatchedCoin,
} from "@/lib/agent";
import { fmtAge, fmtCompact, fmtPct } from "@/lib/format";
import { usePolling, useSolPrice } from "@/lib/hooks";

const sol = (v: number, d = 2) => `${v.toFixed(d)}◎`;

function FlowCell({ f }: { f: Flow }) {
  const total = f.buySol + f.sellSol;
  return (
    <div>
      <div className={`num ${f.netSol > 0 ? "text-emerald-400" : f.netSol < 0 ? "text-rose-400" : "text-zinc-400"}`}>
        {f.netSol > 0 ? "+" : ""}
        {sol(f.netSol)}
      </div>
      <div className="num text-xs text-zinc-500">
        {f.buyers}b / {f.sellers}s · {total ? Math.round((f.buySol / total) * 100) : 0}% buy
      </div>
    </div>
  );
}

const CohortLine = ({ c, label }: { c: Cohort; label: string }) => (
  <span className="num text-xs" title={`${c.wallets} wallets, sold ${(c.soldFraction * 100).toFixed(0)}% of what they bought`}>
    <span className="text-zinc-500">{label}</span> {c.heldPct.toFixed(1)}%
  </span>
);

// Held first, then firing, armed, and by screen verdict: what's closest to a trade is on top.
const rank = (c: WatchedCoin) => (c.held ? 0 : c.setups.some((x) => x.status === "fire") ? 1 : c.setups.length ? 2 : 3);
const VERDICT_ORDER = { ok: 0, warn: 1, unknown: 2, veto: 3 };

export default function Market() {
  const router = useRouter();
  const solUsd = useSolPrice();
  const { data, error } = usePolling<AgentState>("/api/agent/state", 2_000);

  if (error && !data) return <div className="mx-auto max-w-xl rounded-xl border border-zinc-800 p-6 text-sm text-zinc-400">{error}</div>;
  if (!data) return <div className="py-20 text-center text-zinc-500">Connecting to the agent…</div>;

  const coins = [...data.hot].sort(
    (a, b) => rank(a) - rank(b) || VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || (b.score ?? 0) - (a.score ?? 0),
  );
  const a = data.analyst;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <div>
          <h1 className="text-lg font-semibold text-white">Market</h1>
          <p className="text-xs text-zinc-500">
            What the agent is watching right now across New pairs, Final Stretch and Migrated coins — with its live read on each. Click a coin for the
            full evidence.
          </p>
        </div>
        <div className="ml-auto flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
          <span className={`rounded border px-1.5 capitalize ${REGIME_TONE[data.regime.level]}`} title={data.regime.reasons.join("; ")}>
            regime {data.regime.level}
          </span>
          <span className="num">{data.stats.tracked} tracked</span>
          <span className="num">{data.stats.hot} deep-watched</span>
          <span className="num">{data.stats.tradesIngested.toLocaleString()} trades read</span>
          <span
            className={["not-installed", "not-logged-in", "error"].includes(a.status) ? "text-amber-400" : "text-violet-300"}
            title={a.lastError ?? ""}
          >
            analyst {a.running ? `researching ${a.running}` : a.status}
          </span>
          <span
            className={data.treg.configured && !data.treg.disabled ? "" : "text-amber-400"}
            title={data.treg.disabled ?? data.treg.lastError ?? ""}
          >
            web search {data.treg.disabled ? "disabled" : data.treg.configured ? "on" : "not configured"}
          </span>
          {Object.entries(data.http).map(([h, s]) => (
            <span key={h} className={`num ${s.errors > s.ok * 0.1 ? "text-amber-400" : "text-zinc-500"}`} title={s.lastError ?? ""}>
              {h.split(".").slice(-2, -1)[0]} {s.ok}/{s.errors}
              {s.pausedForMs > 0 && " ⏸"}
            </span>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950">
        <table className="w-full min-w-[1100px] text-sm">
          <thead className="text-[11px] uppercase tracking-wide text-zinc-500">
            <tr className="text-left">
              <th className="px-3 py-2 font-medium">Coin</th>
              <th className="px-3 py-2 font-medium">MCap</th>
              <th className="px-3 py-2 font-medium">From ATH</th>
              <th className="px-3 py-2 font-medium">Flow 60s</th>
              <th className="px-3 py-2 font-medium">Flow 5m</th>
              <th className="px-3 py-2 font-medium">Exhaustion</th>
              <th className="px-3 py-2 font-medium">Insider supply</th>
              <th className="px-3 py-2 font-medium">Agent read</th>
              <th className="px-3 py-2 font-medium">Screens</th>
            </tr>
          </thead>
          <tbody>
            {coins.map((c) => {
              const f = c.features;
              return (
                <tr
                  key={c.mint}
                  onClick={() => router.push(`/coin/${c.mint}`)}
                  className="cursor-pointer border-t border-zinc-900 hover:bg-zinc-900/60"
                >
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2.5">
                      <TokenIcon src={coinImage(c.mint)} symbol={c.symbol} size={32} />
                      <div>
                        <div className="font-semibold text-white">{c.symbol}</div>
                        <div className="text-xs text-zinc-500">
                          {c.lane ? <span className={LANE_TONE[c.lane]}>{LANE_LABEL[c.lane]}</span> : c.stage}
                          {c.stage === "curve" && ` ${Math.round((c.curveProgress ?? 0) * 100)}%`} · {fmtAge(c.createdAt)}
                        </div>
                      </div>
                    </div>
                  </td>
                  {f ? (
                    <>
                      <td className="px-3 py-2">
                        <div className="num text-white">{solUsd > 0 ? fmtCompact(f.mcapSol * solUsd) : sol(f.mcapSol, 0)}</div>
                        {f.liquidityUsd !== null && <div className="num text-xs text-zinc-600">liq {fmtCompact(f.liquidityUsd)}</div>}
                      </td>
                      <td className="px-3 py-2">
                        <div className={`num ${f.drawdown > 0.4 ? "text-rose-400" : "text-zinc-300"}`}>{fmtPct(-f.drawdown * 100, 0)}</div>
                        <div className="num text-xs text-zinc-500">
                          {f.minSinceAth.toFixed(0)}m ago{f.higherLow && <span className="ml-1 text-emerald-400">HL</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <FlowCell f={f.flow60s} />
                      </td>
                      <td className="px-3 py-2">
                        <FlowCell f={f.flow5m} />
                      </td>
                      <td className="px-3 py-2">
                        {f.exhaustion === null ? (
                          <span className="text-xs text-zinc-600">idle</span>
                        ) : (
                          <>
                            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-zinc-800">
                              <div className="h-full bg-violet-400" style={{ width: `${f.exhaustion * 100}%` }} />
                            </div>
                            <div className="num mt-0.5 text-xs text-zinc-500">
                              {(f.exhaustion * 100).toFixed(0)} {f.exhaustionBasis === "cohorts" ? "cohorts" : "all"}
                            </div>
                          </>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {f.tapeFromLaunch ? (
                          <div className="flex flex-col">
                            <CohortLine c={f.cohorts.dev} label="dev" />
                            <CohortLine c={f.cohorts.snipers} label="snp" />
                            <CohortLine c={f.cohorts.bundles} label="bdl" />
                          </div>
                        ) : (
                          <span className="text-xs text-zinc-600">tape partial</span>
                        )}
                      </td>
                    </>
                  ) : (
                    <td colSpan={6} className="px-3 py-2 text-xs text-zinc-600">
                      Reading its trades…
                    </td>
                  )}
                  <td className="px-3 py-2">
                    {c.held && <div className="mb-1 text-[11px] font-semibold text-emerald-400">HOLDING</div>}
                    {c.setups.slice(0, 2).map((x) => (
                      <div key={x.setup} className={`text-[11px] ${x.status === "fire" ? "font-semibold text-emerald-300" : "text-violet-300"}`}>
                        {x.status === "fire" ? "● " : "◌ "}
                        {SETUP_LABEL[x.setup] ?? x.setup}
                        {x.status === "armed" && ` ${x.trigger.filter((k) => k.ok).length}/${x.trigger.length}`}
                      </div>
                    ))}
                    {c.analysis && (
                      <span
                        className={`mt-1 inline-block rounded border px-1.5 py-0.5 text-[11px] ${VERDICT_TONE[c.analysis.verdict]} ${c.analysis.expiresAt < Date.now() ? "opacity-50" : ""}`}
                        title={c.analysis.narrative}
                      >
                        AI {c.analysis.verdict} ×{c.analysis.conviction.toFixed(2)}
                      </span>
                    )}
                    {!c.held && !c.setups.length && !c.analysis && <span className="text-xs text-zinc-700">watching</span>}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex max-w-56 flex-wrap gap-1">
                      {c.screens
                        .filter((x) => x.level !== "ok")
                        .map((x) => (
                          <span key={x.id} title={x.detail} className={`rounded border px-1.5 py-0.5 text-[11px] ${SCREEN_TONE[x.level]}`}>
                            {x.label}
                          </span>
                        ))}
                      {c.screens.length > 0 && c.screens.every((x) => x.level === "ok") && (
                        <span className={`rounded border px-1.5 py-0.5 text-[11px] ${SCREEN_TONE.ok}`}>all clear</span>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
