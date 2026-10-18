"use client";

import Link from "next/link";
import { useState } from "react";
import EquityChart from "@/components/EquityChart";
import { ClosedTrades } from "@/components/PositionsTable";
import { pctSigned, SETUP_LABEL, type Account, type PortfolioReport, type Stats } from "@/lib/agent";
import { fmtAge, pnlColor } from "@/lib/format";
import { usePolling } from "@/lib/hooks";

const ROWS: { id: Account["id"]; label: string; blurb: string }[] = [
  { id: "agent", label: "Agent wallet", blurb: "The real strategy: screens, analyst, measured edge, risk sizing and limits" },
  { id: "shadow", label: "Every setup (benchmark)", blurb: "Takes every setup that fires at a fixed 0.1◎ with no filters" },
  { id: "baseline", label: "Random coins (benchmark)", blurb: "Same timing, size and exits as the setups, on random coins" },
];

const statCells = (s: Stats | undefined) =>
  s && s.trades ? (
    <>
      <td className="num px-3 py-2 text-white">{s.trades}</td>
      <td className="num px-3 py-2">{(s.winRate * 100).toFixed(0)}%</td>
      <td className={`num px-3 py-2 ${pnlColor(s.avgR)}`}>{s.avgR.toFixed(2)}R</td>
      <td className={`num px-3 py-2 ${pnlColor(s.returnOnCost)}`}>{pctSigned(s.returnOnCost, 1)}</td>
    </>
  ) : (
    <td colSpan={4} className="px-3 py-2 text-zinc-600">
      no closed trades yet
    </td>
  );

export default function Performance() {
  const { data, error } = usePolling<PortfolioReport>("/api/agent/portfolio", 4_000);
  const [showBenchmarks, setShowBenchmarks] = useState(false);
  if (!data) return <div className="py-20 text-center text-zinc-500">{error ?? "Loading…"}</div>;

  const acct = (id: Account["id"]) => data.accounts.find((a) => a.id === id)!;
  const shadow = acct("shadow");
  const agent = acct("agent");
  const closed = showBenchmarks ? data.closed : data.closed.filter((c) => c.account === "agent");

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-white">Performance</h1>
        <p className="text-xs text-zinc-500">
          Is the agent actually good, or lucky? It only has an edge if it beats both benchmarks after costs, over hundreds of trades and different
          market days.
        </p>
      </div>

      <section className="rounded-xl border border-zinc-800 bg-zinc-950">
        <div className="border-b border-zinc-800 px-4 py-2 text-[11px] uppercase tracking-wide text-zinc-500">Agent vs benchmarks</div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="text-[11px] uppercase tracking-wide text-zinc-500">
              <tr className="text-left">
                <th className="px-4 py-2 font-medium">Account</th>
                <th className="px-3 py-2 font-medium">Equity</th>
                <th className="px-3 py-2 font-medium">Return</th>
                <th className="px-3 py-2 font-medium">Trades</th>
                <th className="px-3 py-2 font-medium">Win rate</th>
                <th className="px-3 py-2 font-medium">Avg R</th>
                <th className="px-3 py-2 font-medium">Return/cost</th>
                <th className="w-48 px-3 py-2 font-medium">Equity curve</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => {
                const a = acct(r.id);
                const ret = a.equity / a.startCash - 1;
                return (
                  <tr key={r.id} className={`border-t border-zinc-900 ${r.id === "agent" ? "bg-emerald-500/[0.03]" : ""}`}>
                    <td className="px-4 py-2">
                      <div className={`font-semibold ${r.id === "agent" ? "text-emerald-300" : "text-zinc-200"}`}>{r.label}</div>
                      <div className="text-xs text-zinc-500">{r.blurb}</div>
                    </td>
                    <td className="num px-3 py-2 text-white">{a.equity.toFixed(3)}◎</td>
                    <td className={`num px-3 py-2 ${pnlColor(ret)}`}>{pctSigned(ret, 2)}</td>
                    {statCells(a.stats)}
                    <td className="px-3 py-2">
                      <EquityChart points={a.curve} start={a.startCash} height={44} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="rounded-xl border border-zinc-800 bg-zinc-950">
          <div className="border-b border-zinc-800 px-4 py-2 text-[11px] uppercase tracking-wide text-zinc-500">Edge by setup</div>
          <table className="w-full text-xs">
            <thead className="text-zinc-500">
              <tr className="text-left">
                <th className="px-4 py-2 font-medium">Setup</th>
                <th className="px-3 py-2 font-medium" colSpan={4}>
                  Every signal (benchmark)
                </th>
                <th className="px-3 py-2 font-medium">Agent</th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(SETUP_LABEL)
                .filter((k) => k !== "random")
                .map((k) => {
                  const ag = agent.bySetup[k];
                  return (
                    <tr key={k} className="border-t border-zinc-900">
                      <td className="px-4 py-2 text-zinc-300">{SETUP_LABEL[k]}</td>
                      {statCells(shadow.bySetup[k])}
                      <td className="num px-3 py-2">
                        {ag?.trades ? (
                          <>
                            {ag.trades} · <span className={pnlColor(ag.avgR)}>{ag.avgR.toFixed(2)}R</span>
                          </>
                        ) : (
                          <span className="text-zinc-600">–</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
          <p className="px-4 py-3 text-[11px] text-zinc-600">
            The agent trades a setup at half risk until it has 15 benchmark trades, then only if the benchmark&apos;s average R after costs is
            positive.
          </p>
        </section>

        <section className="rounded-xl border border-zinc-800 bg-zinc-950">
          <div className="border-b border-zinc-800 px-4 py-2 text-[11px] uppercase tracking-wide text-zinc-500">Does the analyst help?</div>
          <table className="w-full text-xs">
            <thead className="text-zinc-500">
              <tr className="text-left">
                <th className="px-4 py-2 font-medium">Verdict at entry</th>
                <th className="px-3 py-2 font-medium">Trades</th>
                <th className="px-3 py-2 font-medium">Win rate</th>
                <th className="px-3 py-2 font-medium">Avg R</th>
                <th className="px-3 py-2 font-medium">Return/cost</th>
              </tr>
            </thead>
            <tbody>
              {(["approve", "neutral", "reject", "none"] as const).map((v) => (
                <tr key={v} className="border-t border-zinc-900">
                  <td className="px-4 py-2 capitalize text-zinc-300">{v === "none" ? "No verdict yet" : v}</td>
                  {statCells(shadow.byAnalyst?.[v])}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-4 py-3 text-[11px] text-zinc-600">
            Measured on the every-signal benchmark, which trades regardless of the verdict. If “reject” doesn&apos;t do worse than “approve”, the
            analyst isn&apos;t adding value.
          </p>
        </section>
      </div>

      <section className="rounded-xl border border-zinc-800 bg-zinc-950">
        <div className="border-b border-zinc-800 px-4 py-2 text-[11px] uppercase tracking-wide text-zinc-500">
          Decisions (why it bought or passed)
        </div>
        <div className="max-h-[420px] overflow-y-auto">
          {data.decisions.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-zinc-500">No setup has fired since the agent last restarted.</div>
          )}
          {data.decisions.map((d, i) => (
            <div key={`${d.mint}-${d.at}-${i}`} className="border-t border-zinc-900 px-4 py-2 text-xs first:border-t-0">
              <div className="flex items-center gap-2">
                <span
                  className={`rounded px-1.5 py-0.5 font-semibold ${d.take ? "bg-emerald-500/15 text-emerald-300" : "bg-zinc-800 text-zinc-400"}`}
                >
                  {d.take ? "BUY" : "PASS"}
                </span>
                <Link href={`/coin/${d.mint}`} className="font-semibold text-white hover:underline">
                  {d.symbol}
                </Link>
                <span className="text-zinc-500">{SETUP_LABEL[d.setup] ?? d.setup}</span>
                <span className="num ml-auto text-zinc-600">{fmtAge(d.at)} ago</span>
              </div>
              <div className="num mt-1 text-zinc-500">
                {d.mode === "explore"
                  ? `exploring (${d.n}/15 benchmark trades) · half risk`
                  : `benchmark ${d.n} trades · ${(d.p * 100).toFixed(0)}% wins`}{" "}
                · size {d.sizeSol.toFixed(3)}◎ · analyst {d.analyst.verdict} ×{d.analyst.conviction.toFixed(2)}
              </div>
              {d.reasons.length > 0 && <div className="mt-0.5 text-zinc-400">{d.reasons.join(" · ")}</div>}
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-950">
        <div className="flex items-center border-b border-zinc-800 px-4 py-2 text-[11px] uppercase tracking-wide text-zinc-500">
          Closed trades
          <label className="ml-auto flex items-center gap-1.5 normal-case">
            <input type="checkbox" checked={showBenchmarks} onChange={(e) => setShowBenchmarks(e.target.checked)} />
            include benchmarks
          </label>
        </div>
        <div className="max-h-[520px] overflow-y-auto">
          <ClosedTrades trades={closed} showAccount={showBenchmarks} />
        </div>
      </section>
    </div>
  );
}
