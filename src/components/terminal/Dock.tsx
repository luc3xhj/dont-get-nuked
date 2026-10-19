"use client";

import { useState } from "react";
import EquityChart from "../EquityChart";
import EvidencePanel from "../EvidencePanel";
import { ClosedTrades, OpenPositions } from "../PositionsTable";
import { AnalysisCard, CHANGED, DecisionCard } from "../research/ResearchCards";
import { useTerminal } from "./data";
import Funnel from "./Funnel";
import { TradersTab } from "./Traders";
import { Metric } from "./ui";
import type { DockTab, Layout } from "./layout";
import { pctSigned, SETUP_LABEL, type Account, type DatasetSummary, type Stats } from "@/lib/agent";
import { fmtAge, pnlColor } from "@/lib/format";
import { usePolling } from "@/lib/hooks";
import type { ResearchReport } from "@/lib/research-types";

const TABS: { id: DockTab; label: string }[] = [
  { id: "positions", label: "Positions" },
  { id: "trades", label: "Trades" },
  { id: "decisions", label: "Decisions" },
  { id: "research", label: "Research audit" },
  { id: "traders", label: "Traders" },
  { id: "performance", label: "Performance" },
  { id: "evidence", label: "What predicts winners" },
  { id: "dataset", label: "Rug dataset" },
];

const stat = (s?: Stats) =>
  s && s.trades ? (
    <>
      <td className="num px-3 py-1.5 text-white">{s.trades}</td>
      <td className="num px-3 py-1.5">{(s.winRate * 100).toFixed(0)}%</td>
      <td className={`num px-3 py-1.5 ${pnlColor(s.avgR)}`}>{s.avgR.toFixed(2)}R</td>
      <td className={`num px-3 py-1.5 ${pnlColor(s.returnOnCost)}`}>{pctSigned(s.returnOnCost, 1)}</td>
    </>
  ) : (
    <td colSpan={4} className="px-3 py-1.5 text-zinc-600">
      no closed trades yet
    </td>
  );

const ACCOUNTS: { id: Account["id"]; label: string; blurb: string }[] = [
  { id: "agent", label: "Agent wallet", blurb: "Screens, research, measured edge, risk sizing" },
  { id: "shadow", label: "Every setup", blurb: "Benchmark: all fired setups, 0.1◎, no filters" },
  { id: "baseline", label: "Random coins", blurb: "Benchmark: same timing and exits, random coins" },
];

function Performance() {
  const { portfolio } = useTerminal();
  if (!portfolio) return null;
  const acct = (id: Account["id"]) => portfolio.accounts.find((a) => a.id === id)!;
  const shadow = acct("shadow");
  const agent = acct("agent");
  return (
    <div className="grid gap-4 p-3 xl:grid-cols-[1.3fr_1fr]">
      <div>
        <div className="label mb-2">Agent vs benchmarks — an edge means beating both, after costs, over hundreds of trades</div>
        <table className="w-full text-xs">
          <thead className="text-zinc-500">
            <tr className="text-left">
              <th className="px-3 py-1 font-medium">Account</th>
              <th className="px-3 py-1 font-medium">Equity</th>
              <th className="px-3 py-1 font-medium">Return</th>
              <th className="px-3 py-1 font-medium">Trades</th>
              <th className="px-3 py-1 font-medium">Win</th>
              <th className="px-3 py-1 font-medium">Avg R</th>
              <th className="px-3 py-1 font-medium">Ret/cost</th>
              <th className="w-36 px-3 py-1 font-medium">Curve</th>
            </tr>
          </thead>
          <tbody>
            {ACCOUNTS.map((r) => {
              const a = acct(r.id);
              const ret = a.equity / a.startCash - 1;
              return (
                <tr key={r.id} className="border-t border-line" title={r.blurb}>
                  <td className={`px-3 py-1.5 font-medium ${r.id === "agent" ? "text-emerald-300" : "text-zinc-300"}`}>{r.label}</td>
                  <td className="num px-3 py-1.5 text-white">{a.equity.toFixed(3)}◎</td>
                  <td className={`num px-3 py-1.5 ${pnlColor(ret)}`}>{pctSigned(ret, 2)}</td>
                  {stat(a.stats)}
                  <td className="px-3 py-1">
                    <EquityChart points={a.curve} start={a.startCash} height={30} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="space-y-4">
        <div>
          <div className="label mb-2">Edge by setup (every-setup benchmark · agent)</div>
          <table className="w-full text-xs">
            <tbody>
              {Object.keys(SETUP_LABEL)
                .filter((k) => k !== "random")
                .map((k) => {
                  const s = shadow.bySetup[k];
                  const g = agent.bySetup[k];
                  return (
                    <tr key={k} className="border-t border-line">
                      <td className="py-1.5 pr-3 text-zinc-300">{SETUP_LABEL[k]}</td>
                      <td className="num py-1.5 pr-3">
                        {s?.trades ? (
                          <>
                            {s.trades} · {(s.winRate * 100).toFixed(0)}% · <span className={pnlColor(s.avgR)}>{s.avgR.toFixed(2)}R</span>
                          </>
                        ) : (
                          <span className="text-zinc-700">–</span>
                        )}
                      </td>
                      <td className="num py-1.5">
                        {g?.trades ? (
                          <>
                            {g.trades} · <span className={pnlColor(g.avgR)}>{g.avgR.toFixed(2)}R</span>
                          </>
                        ) : (
                          <span className="text-zinc-700">–</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        <div>
          <div className="label mb-2">Benchmark result by analyst verdict at entry</div>
          <div className="num flex flex-wrap gap-x-4 text-xs">
            {(["approve", "neutral", "reject", "none"] as const).map((v) => {
              const s = shadow.byAnalyst?.[v];
              return (
                <span key={v}>
                  <span className="text-zinc-500">{v}</span>{" "}
                  {s?.trades ? (
                    <>
                      {s.trades} · <span className={pnlColor(s.avgR)}>{s.avgR.toFixed(2)}R</span>
                    </>
                  ) : (
                    <span className="text-zinc-700">–</span>
                  )}
                </span>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function Decisions({ onSelect }: { onSelect: (mint: string) => void }) {
  const { portfolio } = useTerminal();
  const rows = portfolio?.decisions ?? [];
  const cov = portfolio?.researchCoverage;
  const header = portfolio?.strategyVersion && (
    <div className="num border-b border-line px-3 py-1.5 text-[11px] text-zinc-500">
      Strategy {portfolio.strategyVersion} · learns from {portfolio.evidenceVersions?.join(", ") ?? "–"}
      {cov &&
        ` · research coverage ${cov.decisions ? `${(cov.share * 100).toFixed(0)}% of ${cov.decisions} decisions` : "no decisions yet"}${cov.medianAgeMin != null ? `, median report age ${cov.medianAgeMin.toFixed(0)}m` : ""}`}
    </div>
  );
  if (!rows.length)
    return (
      <>
        <Funnel onSelect={onSelect} />
        {header}
        <div className="p-4 text-xs text-zinc-500">No setup has fired since the agent last restarted.</div>
      </>
    );
  return (
    <>
      <Funnel onSelect={onSelect} />
      {header}
      <table className="w-full text-xs">
      <tbody>
        {rows.map((d, i) => (
          <tr key={`${d.mint}-${d.at}-${i}`} onClick={() => onSelect(d.mint)} className="cursor-pointer border-t border-line first:border-t-0 hover:bg-panel-2">
            <td className="px-3 py-1.5">
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${d.take ? "bg-emerald-500/15 text-emerald-300" : "bg-zinc-800 text-zinc-400"}`}>
                {d.take ? "BUY" : "PASS"}
              </span>
            </td>
            <td className="px-2 py-1.5 font-semibold text-zinc-100">{d.symbol}</td>
            <td className="px-2 py-1.5 text-zinc-500">{SETUP_LABEL[d.setup] ?? d.setup}</td>
            <td className="num px-2 py-1.5 text-zinc-400" title={d.costs ? `Round trip ${(d.costs.roundTripCostPct * 100).toFixed(1)}% · net R/R ${d.costs.netRewardRisk.toFixed(2)}` : undefined}>
              {d.sizeSol.toFixed(3)}◎{d.costs && <span className="text-zinc-600"> · R/R {d.costs.netRewardRisk.toFixed(1)}</span>}
            </td>
            <td className="px-2 py-1.5 text-zinc-500">
              AI {d.analyst.verdict} ×{d.analyst.conviction.toFixed(2)}
              {d.regime && ` · ${d.regime.level}`}
            </td>
            <td className="max-w-md truncate px-2 py-1.5 text-zinc-400" title={d.reasons.join(" · ")}>
              {d.reasons.join(" · ") || "All gates passed"}
            </td>
            <td className="num px-3 py-1.5 text-right text-zinc-600">{fmtAge(d.at)} ago</td>
          </tr>
        ))}
      </tbody>
    </table>
    </>
  );
}

function ResearchAudit() {
  const { data, error } = usePolling<ResearchReport>("/api/agent/research", 10_000);
  const [changedOnly, setChangedOnly] = useState(false);
  if (!data) return <div className="p-4 text-xs text-zinc-500">{error ?? "Loading research history…"}</div>;
  const changed = data.decisions.filter((x) => CHANGED.has(x.effect));
  const list = changedOnly ? changed : data.decisions;
  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-stretch gap-2">
        <div className="grid min-w-[16rem] flex-1 grid-cols-3 gap-2 sm:max-w-md">
          <Metric label="Reports · 7d" value={data.analyses.length} />
          <Metric label="Used in decisions" value={data.decisions.filter((x) => x.analysisId).length} />
          <Metric label="Changed" value={changed.length} tone={changed.length ? "info" : undefined} />
        </div>
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 self-center text-xs text-zinc-400">
          <input type="checkbox" checked={changedOnly} onChange={(e) => setChangedOnly(e.target.checked)} className="accent-violet-500" />
          Only decisions research changed
        </label>
      </div>
      <p className="text-[11px] text-zinc-500">
        &ldquo;Without analysis&rdquo; replays the same moment with the default 0.5× size and no verdict; the market, risk limits and setup are unchanged. Research never creates a setup.
      </p>
      <div className="grid items-start gap-3 lg:grid-cols-2">
        <div className="space-y-2">
          <div className="label">Codex reports</div>
          {!data.analyses.length && <p className="text-xs text-zinc-500">No completed analysis in the last 7 days.</p>}
          {data.analyses.map((a) => (
            <AnalysisCard key={a.id} a={a} decisions={data.decisions} now={data.now} />
          ))}
        </div>
        <div className="space-y-2">
          <div className="label">Decision audit</div>
          {!list.length && <p className="text-xs text-zinc-500">No decisions in this window.</p>}
          {list.map((d) => (
            <DecisionCard key={d.id} d={d} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Dataset() {
  const { data: ds } = usePolling<DatasetSummary>("/api/agent/dataset", 30_000);
  return (
    <div className="space-y-2 p-3 text-xs">
      <div className="num flex flex-wrap gap-x-6 text-sm">
        <span>
          <span className="text-zinc-500">captured</span> {ds?.captured ?? "…"} {ds && <span className="text-zinc-600">({ds.sampled} random)</span>}
        </span>
        <span>
          <span className="text-zinc-500">labeled at 1h</span> {ds?.labeled ?? "…"}
        </span>
        <span>
          <span className="text-zinc-500">rug rate</span> {ds?.rugRate == null ? "–" : `${(ds.rugRate * 100).toFixed(0)}%`}
        </span>
        <span>
          <span className="text-zinc-500">graduated</span> {ds?.graduated ?? "…"}
        </span>
        <a href="/api/agent/dataset-csv" download className="ml-auto text-zinc-400 underline hover:text-white">
          Download CSV
        </a>
      </div>
      <p className="text-zinc-600">
        First-five-minute features (“Catching the Rug”, arXiv 2608.20271) for watched coins and a random sample of launches, labeled one hour later. A
        classifier trained on a few thousand rows can become a screen.
      </p>
    </div>
  );
}

export default function Dock({ layout, update, onSelect }: { layout: Layout; update: (p: Partial<Layout>) => void; onSelect: (mint: string) => void }) {
  const { portfolio } = useTerminal();
  const [benchmarks, setBenchmarks] = useState(false);
  const open = portfolio?.open.filter((p) => p.account === "agent") ?? [];
  const closed = (portfolio?.closed ?? []).filter((c) => benchmarks || c.account === "agent");
  const unreal = open.reduce((a, p) => a + (p.unrealizedSol ?? 0), 0);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-line px-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => update({ dockTab: t.id, dock: true })}
            className={`-mb-px border-b-2 px-2.5 py-2 text-[11.5px] transition-colors ${
              layout.dockTab === t.id ? "border-violet-400 text-white" : "border-transparent text-zinc-500 hover:text-zinc-200"
            }`}
          >
            {t.label}
            {t.id === "positions" && open.length > 0 && (
              <span className={`num ml-1.5 ${pnlColor(unreal)}`}>
                {open.length} · {unreal >= 0 ? "+" : ""}
                {unreal.toFixed(3)}◎
              </span>
            )}
          </button>
        ))}
        <button onClick={() => update({ dockTall: !layout.dockTall })} className="ml-auto px-2 text-[11px] text-zinc-500 hover:text-zinc-200" title="Taller dock">
          {layout.dockTall ? "▾ smaller" : "▴ taller"}
        </button>
      </div>
      <div className="scroll-thin flex-1 overflow-y-auto">
        {layout.dockTab === "positions" && <OpenPositions positions={open} />}
        {layout.dockTab === "trades" && (
          <div>
            <label className="flex items-center gap-1.5 px-3 pt-2 text-[11px] text-zinc-500">
              <input type="checkbox" checked={benchmarks} onChange={(e) => setBenchmarks(e.target.checked)} className="accent-violet-500" />
              include benchmark trades
            </label>
            <ClosedTrades trades={closed} showAccount={benchmarks} />
          </div>
        )}
        {layout.dockTab === "decisions" && <Decisions onSelect={onSelect} />}
        {layout.dockTab === "research" && <ResearchAudit />}
        {layout.dockTab === "traders" && <TradersTab onSelect={onSelect} />}
        {layout.dockTab === "performance" && <Performance />}
        {layout.dockTab === "evidence" && <EvidencePanel />}
        {layout.dockTab === "dataset" && <Dataset />}
      </div>
    </div>
  );
}
