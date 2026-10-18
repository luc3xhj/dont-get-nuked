"use client";

import ActivityFeed from "@/components/ActivityFeed";
import EquityChart from "@/components/EquityChart";
import { ClosedTrades, OpenPositions } from "@/components/PositionsTable";
import { pctSigned, solSigned, type AgentState, type PortfolioReport } from "@/lib/agent";
import { fmtCompact, pnlColor } from "@/lib/format";
import { usePolling, useSolPrice } from "@/lib/hooks";

function Tile({ label, value, sub, tone = "" }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="bg-zinc-950 p-4">
      <div className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`num mt-1 text-lg ${tone || "text-white"}`}>{value}</div>
      {sub && <div className="text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}

export default function Dashboard() {
  const solUsd = useSolPrice();
  const { data: p, error } = usePolling<PortfolioReport>("/api/agent/portfolio", 3_000);
  const { data: st } = usePolling<AgentState>("/api/agent/state", 5_000);

  if (error && !p)
    return (
      <div className="mx-auto max-w-xl rounded-xl border border-zinc-800 p-6 text-sm text-zinc-400">
        <div className="mb-2 font-semibold text-white">Agent offline</div>
        {error}
      </div>
    );
  if (!p) return <div className="py-20 text-center text-zinc-500">Connecting to the agent…</div>;

  const a = p.accounts.find((x) => x.id === "agent")!;
  const pnl = a.equity - a.startCash;
  const today = a.curve.filter(([t]) => t >= new Date().setUTCHours(0, 0, 0, 0));
  const todayPnl = today.length ? a.equity - today[0][1] : 0;
  const open = p.open.filter((x) => x.account === "agent");
  const closed = p.closed.filter((x) => x.account === "agent");
  const armed = st?.hot.filter((c) => c.setups.length).length ?? 0;
  const control = (action: "pause" | "resume") => fetch(`/api/agent/control?action=${action}`, { method: "POST" });

  return (
    <div className="space-y-4">
      <section className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-5">
          <div className="flex flex-wrap items-start gap-4">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-zinc-500">Agent wallet · simulated</div>
              <div className="num mt-1 text-3xl font-semibold text-white">{a.equity.toFixed(3)} SOL</div>
              <div className="num mt-1 flex flex-wrap gap-x-3 text-sm">
                <span className={pnlColor(pnl)}>
                  {solSigned(pnl)} ({pctSigned(pnl / a.startCash, 2)}) all-time
                </span>
                <span className={pnlColor(todayPnl)}>{solSigned(todayPnl)} today</span>
                {solUsd > 0 && <span className="text-zinc-500">{fmtCompact(a.equity * solUsd)}</span>}
              </div>
            </div>
            <div className="ml-auto text-right text-xs">
              {a.paused ? (
                <>
                  <div className="text-amber-300">{a.paused}</div>
                  <button
                    onClick={() => control("resume")}
                    className="mt-2 rounded-md bg-emerald-500 px-3 py-1.5 font-semibold text-black hover:bg-emerald-400"
                  >
                    Resume trading
                  </button>
                </>
              ) : (
                <>
                  <div className="text-emerald-400">{a.cooldownUntil > Date.now() ? "Cooling down after losses" : "Trading autonomously"}</div>
                  <button onClick={() => control("pause")} className="mt-2 rounded-md bg-zinc-800 px-3 py-1.5 hover:bg-zinc-700">
                    Pause new entries
                  </button>
                </>
              )}
            </div>
          </div>
          <div className="mt-4">
            <EquityChart points={a.curve} start={a.startCash} height={160} />
          </div>
          <div className="num mt-2 flex flex-wrap gap-x-4 text-xs text-zinc-500">
            <span>cash {a.cash.toFixed(3)}◎</span>
            <span>in positions {a.positions.toFixed(3)}◎</span>
            <span>started with {a.startCash}◎</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-zinc-800 bg-zinc-800">
          <Tile label="Closed trades" value={`${a.stats.trades}`} sub={`${open.length} open`} />
          <Tile label="Win rate" value={a.stats.trades ? `${(a.stats.winRate * 100).toFixed(0)}%` : "–"} />
          <Tile label="Avg R" value={a.stats.trades ? a.stats.avgR.toFixed(2) : "–"} tone={pnlColor(a.stats.avgR)} sub="profit per unit of risk" />
          <Tile
            label="Return on cost"
            value={a.stats.trades ? pctSigned(a.stats.returnOnCost, 1) : "–"}
            tone={pnlColor(a.stats.returnOnCost)}
            sub="after all fees"
          />
          <Tile
            label="Watching"
            value={st ? `${st.stats.hot} coins` : "…"}
            sub={st ? `${st.stats.tracked} tracked · ${armed} with setups` : undefined}
          />
          <Tile
            label="Analyst"
            value={st ? (st.analyst.running ? "researching" : st.analyst.status) : "…"}
            tone={st && ["not-installed", "not-logged-in", "error"].includes(st.analyst.status) ? "text-amber-300" : "text-white"}
            sub={st ? `${st.analyst.callsLastHour}/${st.analyst.maxPerHour} calls this hour` : undefined}
          />
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <div className="space-y-4">
          <div className="rounded-xl border border-zinc-800 bg-zinc-950">
            <div className="border-b border-zinc-800 px-4 py-2 text-[11px] uppercase tracking-wide text-zinc-500">
              Open positions{p.pending.filter((o) => o.account === "agent").length > 0 && " · orders in flight"}
            </div>
            <OpenPositions positions={open} />
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-950">
            <div className="border-b border-zinc-800 px-4 py-2 text-[11px] uppercase tracking-wide text-zinc-500">Recent trades</div>
            <ClosedTrades trades={closed.slice(0, 12)} />
          </div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-950">
          <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2 text-[11px] uppercase tracking-wide text-zinc-500">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" /> Live activity
          </div>
          <div className="max-h-[720px] overflow-y-auto">
            <ActivityFeed limit={80} />
          </div>
        </div>
      </section>
    </div>
  );
}
