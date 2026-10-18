"use client";

import { fmtAge, fmtPrice, pnlColor } from "@/lib/format";
import { usePolling } from "@/lib/hooks";

// Mirrors agent/portfolio.ts portfolioReport() (kept loose: this panel only renders it).
type Stats = { trades: number; winRate: number; pnlSol: number; returnOnCost: number; avgR: number; expectancySol: number; bestShare: number | null };
type Account = {
  id: "agent" | "shadow" | "baseline";
  cash: number;
  positions: number;
  equity: number;
  unpriced: number;
  startCash: number;
  paused: string | null;
  cooldownUntil: number;
  lossStreak: number;
  stats: Stats;
  bySetup: Record<string, Stats>;
  curve: [number, number][];
};
type Plan = { entrySol: number; stopSol: number; tp1Sol: number; tp2Sol: number; maxHoldMin: number };
type Open = {
  id: string;
  account: Account["id"];
  mint: string;
  symbol: string;
  setup: string;
  openedAt: number;
  entryPriceSol: number;
  costSol: number;
  proceedsSol: number;
  plan: Plan;
  stopSol: number;
  tp1Done: boolean;
  priceSol: number | null;
  unrealizedSol: number | null;
  heldMin: number;
  evidence: string[];
};
type Closed = {
  id: string;
  account: Account["id"];
  symbol: string;
  setup: string;
  closedAt: number;
  costSol: number;
  pnlSol: number;
  pnlPct: number;
  r: number;
  exitReason: string;
  holdMin: number;
};
type Decision = {
  at: number;
  mint: string;
  symbol: string;
  setup: string;
  take: boolean;
  sizeSol: number;
  ev: number;
  p: number;
  mode: "explore" | "evidence";
  n: number;
  reasons: string[];
};
type Report = {
  accounts: Account[];
  open: Open[];
  pending: { account: string; mint: string; side: string; reason: string; ageMs: number }[];
  closed: Closed[];
  decisions: Decision[];
};

export const SETUP_LABEL: Record<string, string> = {
  new_dump: "New · first dump",
  stretch_deep: "Stretch · deep selloff",
  stretch_pullback: "Stretch · pullback",
  dev_base: "Proven dev · base",
  migrated_base: "Migrated · base",
  random: "Random control",
};

const ACCOUNT: Record<Account["id"], { label: string; blurb: string; tone: string }> = {
  agent: { label: "Agent", blurb: "Screens, EV after costs, risk sizing and limits", tone: "border-emerald-800" },
  shadow: { label: "Shadow book", blurb: "Every setup that fires, fixed 0.1◎, no filters", tone: "border-violet-800" },
  baseline: { label: "Random baseline", blurb: "Same timing, size and exits on random coins", tone: "border-zinc-700" },
};

const sol = (v: number, d = 3) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}◎`;
const pct = (v: number, d = 0) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;

function Spark({ points }: { points: [number, number][] }) {
  if (points.length < 2) return <div className="h-10 text-xs text-zinc-600">Equity curve starts after the first minute</div>;
  const ys = points.map((p) => p[1]);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const span = max - min || 1;
  const d = points.map((p, i) => `${(i / (points.length - 1)) * 100},${40 - ((p[1] - min) / span) * 36 - 2}`).join(" ");
  const up = ys.at(-1)! >= ys[0];
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-10 w-full">
      <polyline
        points={d}
        fill="none"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        className={up ? "stroke-emerald-400" : "stroke-rose-400"}
      />
    </svg>
  );
}

function StatLine({ s }: { s: Stats }) {
  return (
    <div className="num grid grid-cols-4 gap-2 text-xs">
      <div>
        <div className="text-zinc-500">Trades</div>
        <div className="text-white">{s.trades}</div>
      </div>
      <div>
        <div className="text-zinc-500">Win rate</div>
        <div className="text-white">{s.trades ? `${(s.winRate * 100).toFixed(0)}%` : "–"}</div>
      </div>
      <div>
        <div className="text-zinc-500">Avg R</div>
        <div className={pnlColor(s.avgR)}>{s.trades ? s.avgR.toFixed(2) : "–"}</div>
      </div>
      <div>
        <div className="text-zinc-500">Return/cost</div>
        <div className={pnlColor(s.returnOnCost)}>{s.trades ? pct(s.returnOnCost, 1) : "–"}</div>
      </div>
    </div>
  );
}

export default function TradingPanel() {
  const { data, error } = usePolling<Report>("/api/agent/portfolio", 2_000);
  if (!data) return <div className="py-10 text-center text-sm text-zinc-500">{error ?? "Loading portfolio…"}</div>;
  const agent = data.accounts.find((a) => a.id === "agent")!;

  const control = (action: "pause" | "resume") => fetch(`/api/agent/control?action=${action}`, { method: "POST" });

  return (
    <div className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-3">
        {data.accounts.map((a) => {
          const ret = a.equity / a.startCash - 1;
          return (
            <div key={a.id} className={`space-y-3 rounded-xl border bg-zinc-950 p-4 ${ACCOUNT[a.id].tone}`}>
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-semibold text-white">{ACCOUNT[a.id].label}</div>
                  <div className="text-xs text-zinc-500">{ACCOUNT[a.id].blurb}</div>
                </div>
                <div className="text-right">
                  <div className="num text-white">{a.equity.toFixed(3)}◎</div>
                  <div className={`num text-xs ${pnlColor(ret)}`}>{pct(ret, 2)}</div>
                </div>
              </div>
              <Spark points={a.curve} />
              <StatLine s={a.stats} />
              {a.id === "agent" && (
                <div className="flex items-center gap-2 text-xs">
                  {a.paused ? (
                    <>
                      <span className="text-amber-300">{a.paused}</span>
                      <button onClick={() => control("resume")} className="ml-auto rounded bg-zinc-800 px-2 py-1 hover:bg-zinc-700">
                        Resume
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="text-emerald-400">Trading</span>
                      {a.cooldownUntil > Date.now() && <span className="text-amber-300">cooldown</span>}
                      <button onClick={() => control("pause")} className="ml-auto rounded bg-zinc-800 px-2 py-1 hover:bg-zinc-700">
                        Pause new entries
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <section className="rounded-xl border border-zinc-800 bg-zinc-950">
        <div className="border-b border-zinc-800 px-4 py-2 text-[11px] uppercase tracking-wide text-zinc-500">
          Open positions ({data.open.length}){data.pending.length > 0 && ` · ${data.pending.length} orders in flight`}
        </div>
        {data.open.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-zinc-500">No open positions. Setups are being watched on the Market tab.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <tbody>
                {data.open
                  .sort((a, b) => a.account.localeCompare(b.account))
                  .map((p) => {
                    const move = p.priceSol ? p.priceSol / p.entryPriceSol - 1 : null;
                    return (
                      <tr key={p.id} className="border-t border-zinc-900 first:border-t-0" title={p.evidence.join("\n")}>
                        <td className="px-4 py-2">
                          <div className="font-semibold text-white">{p.symbol}</div>
                          <div className="text-xs text-zinc-500">
                            {ACCOUNT[p.account].label} · {SETUP_LABEL[p.setup] ?? p.setup}
                          </div>
                        </td>
                        <td className="num px-3 py-2 text-xs">
                          <div className="text-zinc-300">{p.costSol.toFixed(3)}◎ in</div>
                          <div className="text-zinc-500">
                            {p.heldMin.toFixed(1)}m / {p.plan.maxHoldMin}m
                          </div>
                        </td>
                        <td className={`num px-3 py-2 ${pnlColor(move ?? 0)}`}>{move === null ? "…" : pct(move, 1)}</td>
                        <td className={`num px-3 py-2 ${pnlColor(p.unrealizedSol ?? 0)}`}>{p.unrealizedSol === null ? "…" : sol(p.unrealizedSol)}</td>
                        <td className="num px-3 py-2 text-xs text-zinc-400">
                          <div>
                            stop {pct(p.stopSol / p.entryPriceSol - 1)} {p.tp1Done && <span className="text-emerald-400">trailing</span>}
                          </div>
                          <div>
                            tp1 {pct(p.plan.tp1Sol / p.entryPriceSol - 1)} · tp2 {pct(p.plan.tp2Sol / p.entryPriceSol - 1)}
                          </div>
                        </td>
                        <td className="num px-3 py-2 text-xs text-zinc-500">{fmtPrice(p.entryPriceSol, "")}◎</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="rounded-xl border border-zinc-800 bg-zinc-950">
          <div className="border-b border-zinc-800 px-4 py-2 text-[11px] uppercase tracking-wide text-zinc-500">Agent decisions</div>
          <div className="max-h-96 overflow-y-auto">
            {data.decisions.length === 0 && <div className="px-4 py-6 text-center text-sm text-zinc-500">No setup has fired yet.</div>}
            {data.decisions.map((d, i) => (
              <div key={`${d.mint}-${d.at}-${i}`} className="border-t border-zinc-900 px-4 py-2 text-xs first:border-t-0">
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded px-1.5 py-0.5 font-semibold ${d.take ? "bg-emerald-500/15 text-emerald-300" : "bg-zinc-800 text-zinc-400"}`}
                  >
                    {d.take ? "BUY" : "PASS"}
                  </span>
                  <span className="font-semibold text-white">{d.symbol}</span>
                  <span className="text-zinc-500">{SETUP_LABEL[d.setup] ?? d.setup}</span>
                  <span className="num ml-auto text-zinc-600">{fmtAge(d.at)} ago</span>
                </div>
                <div className="num mt-1 text-zinc-500">
                  {d.mode === "explore"
                    ? `exploring (${d.n}/15 shadow trades) · half risk`
                    : `shadow ${d.n} trades · ${(d.p * 100).toFixed(0)}% wins · edge ${pct(d.ev, 1)}`}{" "}
                  · size {d.sizeSol.toFixed(3)}◎
                </div>
                {d.reasons.length > 0 && <div className="mt-0.5 text-zinc-400">{d.reasons.join(" · ")}</div>}
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-zinc-800 bg-zinc-950">
          <div className="border-b border-zinc-800 px-4 py-2 text-[11px] uppercase tracking-wide text-zinc-500">Edge by setup (shadow vs agent)</div>
          <table className="w-full text-xs">
            <thead className="text-zinc-500">
              <tr className="text-left">
                <th className="px-4 py-2 font-medium">Setup</th>
                <th className="px-3 py-2 font-medium">Shadow n · win · avg R</th>
                <th className="px-3 py-2 font-medium">Agent n · win · avg R</th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(SETUP_LABEL)
                .filter((k) => k !== "random")
                .map((k) => {
                  const sh = data.accounts.find((a) => a.id === "shadow")!.bySetup[k];
                  const ag = agent.bySetup[k];
                  const cell = (s?: Stats) =>
                    s ? (
                      <span className="num">
                        {s.trades} · {(s.winRate * 100).toFixed(0)}% · <span className={pnlColor(s.avgR)}>{s.avgR.toFixed(2)}</span>
                      </span>
                    ) : (
                      <span className="text-zinc-600">–</span>
                    );
                  return (
                    <tr key={k} className="border-t border-zinc-900">
                      <td className="px-4 py-2 text-zinc-300">{SETUP_LABEL[k]}</td>
                      <td className="px-3 py-2">{cell(sh)}</td>
                      <td className="px-3 py-2">{cell(ag)}</td>
                    </tr>
                  );
                })}
              <tr className="border-t border-zinc-800">
                <td className="px-4 py-2 text-zinc-300">{SETUP_LABEL.random}</td>
                <td className="px-3 py-2" colSpan={2}>
                  {(() => {
                    const b = data.accounts.find((a) => a.id === "baseline")!.stats;
                    return b.trades ? (
                      <span className="num">
                        {b.trades} · {(b.winRate * 100).toFixed(0)}% · <span className={pnlColor(b.avgR)}>{b.avgR.toFixed(2)}</span>
                      </span>
                    ) : (
                      <span className="text-zinc-600">–</span>
                    );
                  })()}
                </td>
              </tr>
            </tbody>
          </table>
          <p className="px-4 pb-3 text-[11px] text-zinc-600">
            A setup has an edge only if its shadow avg R beats the random baseline after costs, over hundreds of trades.
          </p>
        </section>
      </div>

      <section className="rounded-xl border border-zinc-800 bg-zinc-950">
        <div className="border-b border-zinc-800 px-4 py-2 text-[11px] uppercase tracking-wide text-zinc-500">Closed trades</div>
        <div className="max-h-96 overflow-x-auto overflow-y-auto">
          <table className="w-full min-w-[760px] text-xs">
            <tbody>
              {data.closed.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-sm text-zinc-500">No closed trades yet.</td>
                </tr>
              )}
              {data.closed.map((c) => (
                <tr key={c.id} className="border-t border-zinc-900 first:border-t-0">
                  <td className="px-4 py-1.5 text-zinc-500">{fmtAge(c.closedAt)} ago</td>
                  <td className="px-3 py-1.5 text-zinc-400">{ACCOUNT[c.account].label}</td>
                  <td className="px-3 py-1.5 font-semibold text-white">{c.symbol}</td>
                  <td className="px-3 py-1.5 text-zinc-500">{SETUP_LABEL[c.setup] ?? c.setup}</td>
                  <td className={`num px-3 py-1.5 ${pnlColor(c.pnlSol)}`}>{sol(c.pnlSol)}</td>
                  <td className={`num px-3 py-1.5 ${pnlColor(c.pnlPct)}`}>{pct(c.pnlPct, 1)}</td>
                  <td className={`num px-3 py-1.5 ${pnlColor(c.r)}`}>{c.r.toFixed(2)}R</td>
                  <td className="num px-3 py-1.5 text-zinc-500">{c.holdMin.toFixed(1)}m</td>
                  <td className="px-3 py-1.5 text-zinc-400">{c.exitReason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
