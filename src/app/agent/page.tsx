"use client";

import { useState } from "react";
import { CopyIcon } from "@/components/Icons";
import TradingPanel, { SETUP_LABEL } from "@/components/TradingPanel";
import { fmtAge, fmtCompact, fmtPct } from "@/lib/format";
import { usePolling, useSolPrice } from "@/lib/hooks";

// Mirrors agent/types.ts (kept loose: this page only renders it).
type Flow = {
  buySol: number;
  sellSol: number;
  netSol: number;
  buys: number;
  sells: number;
  buyers: number;
  sellers: number;
  newBuyerShare: number;
  medianBuySol: number;
  maxBuySol: number;
  roundTripShare: number;
};
type Cohort = {
  wallets: number;
  heldPct: number;
  soldFraction: number;
  sellSol60s: number;
};
type Features = {
  ageMin: number;
  priceSol: number;
  mcapSol: number;
  athMcapSol: number;
  drawdown: number;
  minSinceAth: number;
  bounceFromLow: number;
  range10m: number;
  higherLow: boolean;
  flow15s: Flow;
  flow60s: Flow;
  flow5m: Flow;
  cohorts: { dev: Cohort; snipers: Cohort; bundles: Cohort; early: Cohort };
  exhaustion: number | null;
  exhaustionBasis: "cohorts" | "all-sellers";
  liquidityUsd: number | null;
  tapeTrades: number;
  tapeFromLaunch: boolean;
};
type Screen = {
  id: string;
  label: string;
  level: "veto" | "warn" | "ok" | "unknown";
  detail: string;
};
type Check = { label: string; ok: boolean; value: string };
type SetupEval = {
  setup: string;
  status: "armed" | "fire";
  structure: Check[];
  trigger: Check[];
  quality: number;
};
type HotCoin = {
  mint: string;
  symbol: string;
  name: string;
  stage: "curve" | "migrated";
  lane: "new" | "stretch" | "migrated" | null;
  createdAt: number;
  socials: {
    twitter: string | null;
    telegram: string | null;
    website: string | null;
  };
  score: number | null;
  verdict: Screen["level"];
  screens: Screen[];
  features: Features | null;
  setups: SetupEval[];
  held: boolean;
  curveProgress: number | null;
  social: {
    kind: string;
    text: string | null;
    likes: number | null;
    views: number | null;
    author: string | null;
    authorFollowers: number | null;
  } | null;
};
type State = {
  now: number;
  startedAt: number;
  stats: {
    tracked: number;
    hot: number;
    tapePolls: number;
    tapeErrors: number;
    tradesIngested: number;
    listErrors: number;
  };
  http: Record<
    string,
    {
      ok: number;
      errors: number;
      pausedForMs: number;
      lastError: string | null;
    }
  >;
  hot: HotCoin[];
};
type Trade = {
  id: string;
  ts: number;
  wallet: string;
  side: "buy" | "sell";
  sol: number;
  priceSol: number;
};
type Detail = HotCoin & {
  recentTrades: Trade[];
  holdersReport: {
    top: { owner: string; pct: number; insider: boolean }[];
    totalHolders: number | null;
  } | null;
};

const LEVEL: Record<Screen["level"], string> = {
  veto: "bg-rose-500/15 text-rose-300 border-rose-900",
  warn: "bg-amber-500/10 text-amber-300 border-amber-900",
  ok: "bg-emerald-500/10 text-emerald-300 border-emerald-900",
  unknown: "bg-zinc-800 text-zinc-400 border-zinc-700",
};

const sol = (v: number, d = 2) => `${v.toFixed(d)}◎`;

function Meter({ value, tone = "emerald" }: { value: number; tone?: "emerald" | "violet" | "rose" }) {
  const color = {
    emerald: "bg-emerald-400",
    violet: "bg-violet-400",
    rose: "bg-rose-400",
  }[tone];
  return (
    <div className="h-1.5 w-16 overflow-hidden rounded-full bg-zinc-800">
      <div className={`h-full ${color}`} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

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

function CohortCell({ c, label }: { c: Cohort; label: string }) {
  return (
    <span className="num text-xs" title={`${c.wallets} wallets, sold ${(c.soldFraction * 100).toFixed(0)}% of what they bought`}>
      <span className="text-zinc-500">{label}</span> {c.heldPct.toFixed(1)}%
    </span>
  );
}

export default function AgentConsole() {
  const solUsd = useSolPrice();
  const { data, error } = usePolling<State>("/api/agent/state", 2_000);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<"market" | "trading">("market");
  const detail = usePolling<Detail>(selected ? `/api/agent/coin/${selected}` : null, 2_000);

  if (error && !data)
    return (
      <div className="mx-auto max-w-xl rounded-xl border border-zinc-800 p-6 text-sm text-zinc-400">
        <div className="mb-2 font-semibold text-white">Agent worker offline</div>
        {error}
      </div>
    );
  if (!data) return <div className="py-20 text-center text-zinc-500">Connecting to agent…</div>;

  const order = { ok: 0, warn: 1, unknown: 2, veto: 3 };
  // Held and armed/firing coins first, then by screen verdict.
  const rank = (c: HotCoin) => (c.held ? 0 : c.setups.some((x) => x.status === "fire") ? 1 : c.setups.length ? 2 : 3);
  const hot = [...data.hot].sort((a, b) => rank(a) - rank(b) || order[a.verdict] - order[b.verdict] || (b.score ?? 0) - (a.score ?? 0));
  const d = detail.data && detail.data.mint === selected ? detail.data : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <div>
          <h1 className="text-lg font-semibold text-white">Agent console</h1>
          <p className="text-xs text-zinc-500">
            Paper only. Live tapes, cohorts, holders, screens and five setups; three accounts trade the same feed.
          </p>
        </div>
        <div className="flex rounded-lg bg-zinc-900 p-0.5">
          {(["market", "trading"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-md px-3 py-1 text-xs capitalize ${tab === t ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-white"}`}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap gap-4 text-xs text-zinc-400">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" /> up {fmtAge(data.startedAt)}
          </span>
          <span className="num">{data.stats.tracked} tracked</span>
          <span className="num">{data.stats.hot} deep-watched</span>
          <span className="num">{data.stats.tradesIngested.toLocaleString()} trades ingested</span>
          {Object.entries(data.http).map(([h, s]) => (
            <span key={h} className={`num ${s.errors > s.ok * 0.1 ? "text-amber-400" : ""}`} title={s.lastError ?? ""}>
              {h.split(".").slice(-2, -1)[0]} {s.ok}/{s.errors}
              {s.pausedForMs > 0 && " ⏸"}
            </span>
          ))}
        </div>
      </div>

      {tab === "trading" ? (
        <TradingPanel />
      ) : (
        <div className={`grid gap-4 ${selected ? "xl:grid-cols-[1fr_420px]" : ""}`}>
          <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950">
            <table className="w-full min-w-[980px] text-sm">
              <thead className="text-[11px] uppercase tracking-wide text-zinc-500">
                <tr className="text-left">
                  <th className="px-3 py-2 font-medium">Coin</th>
                  <th className="px-3 py-2 font-medium">MCap</th>
                  <th className="px-3 py-2 font-medium">From ATH</th>
                  <th className="px-3 py-2 font-medium">Flow 60s</th>
                  <th className="px-3 py-2 font-medium">Flow 5m</th>
                  <th className="px-3 py-2 font-medium">Exhaustion</th>
                  <th className="px-3 py-2 font-medium">Insider supply</th>
                  <th className="px-3 py-2 font-medium">Setup</th>
                  <th className="px-3 py-2 font-medium">Screens</th>
                </tr>
              </thead>
              <tbody>
                {hot.map((c) => {
                  const f = c.features;
                  return (
                    <tr
                      key={c.mint}
                      onClick={() => setSelected(c.mint)}
                      className={`cursor-pointer border-t border-zinc-900 hover:bg-zinc-900/60 ${selected === c.mint ? "bg-zinc-900" : ""}`}
                    >
                      <td className="px-3 py-2">
                        <div className="font-semibold text-white">{c.symbol}</div>
                        <div className="text-xs text-zinc-500">
                          <span className={c.lane === "new" ? "text-emerald-400" : c.lane === "stretch" ? "text-violet-300" : "text-sky-300"}>
                            {c.lane === "new" ? "New" : c.lane === "stretch" ? "Final Stretch" : c.lane === "migrated" ? "Migrated" : c.stage}
                          </span>
                          {c.stage === "curve" && ` ${Math.round((c.curveProgress ?? 0) * 100)}%`} · {fmtAge(c.createdAt)}
                        </div>
                      </td>
                      {f ? (
                        <>
                          <td className="px-3 py-2">
                            <div className="num text-white">{sol(f.mcapSol, 0)}</div>
                            {solUsd > 0 && <div className="num text-xs text-zinc-500">{fmtCompact(f.mcapSol * solUsd)}</div>}
                            {f.liquidityUsd !== null && <div className="num text-xs text-zinc-600">liq {fmtCompact(f.liquidityUsd)}</div>}
                          </td>
                          <td className="px-3 py-2">
                            <div className={`num ${f.drawdown > 0.4 ? "text-rose-400" : "text-zinc-300"}`}>{fmtPct(-f.drawdown * 100, 0)}</div>
                            <div className="num text-xs text-zinc-500">
                              {f.minSinceAth.toFixed(0)}m ago
                              {f.higherLow && <span className="ml-1 text-emerald-400">HL</span>}
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
                                <Meter value={f.exhaustion} tone="violet" />
                                <div
                                  className="num mt-0.5 text-xs text-zinc-500"
                                  title={f.exhaustionBasis === "cohorts" ? "Launch cohorts' selling" : "All sellers (launch cohorts unknown)"}
                                >
                                  {(f.exhaustion * 100).toFixed(0)} {f.exhaustionBasis === "cohorts" ? "cohorts" : "all"}
                                </div>
                              </>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {f.tapeFromLaunch ? (
                              <div className="flex flex-col">
                                <CohortCell c={f.cohorts.dev} label="dev" />
                                <CohortCell c={f.cohorts.snipers} label="snp" />
                                <CohortCell c={f.cohorts.bundles} label="bdl" />
                              </div>
                            ) : (
                              <span className="text-xs text-zinc-600">tape partial</span>
                            )}
                          </td>
                        </>
                      ) : (
                        <td colSpan={7} className="px-3 py-2 text-xs text-zinc-600">
                          Building tape…
                        </td>
                      )}
                      <td className="px-3 py-2">
                        {c.held && <div className="mb-1 text-[11px] font-semibold text-emerald-400">HOLDING</div>}
                        {c.setups.slice(0, 2).map((x) => (
                          <div
                            key={x.setup}
                            className={`text-[11px] ${x.status === "fire" ? "font-semibold text-emerald-300" : "text-violet-300"}`}
                            title={[...x.structure, ...x.trigger].map((k) => `${k.ok ? "✓" : "✗"} ${k.label}: ${k.value}`).join("\n")}
                          >
                            {x.status === "fire" ? "● " : "◌ "}
                            {SETUP_LABEL[x.setup] ?? x.setup}
                            {x.status === "armed" && ` ${x.trigger.filter((k) => k.ok).length}/${x.trigger.length}`}
                          </div>
                        ))}
                        {!c.held && !c.setups.length && <span className="text-xs text-zinc-700">–</span>}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex max-w-56 flex-wrap gap-1">
                          {c.screens
                            .filter((x) => x.level !== "ok")
                            .map((x) => (
                              <span key={x.id} title={x.detail} className={`rounded border px-1.5 py-0.5 text-[11px] ${LEVEL[x.level]}`}>
                                {x.label}
                              </span>
                            ))}
                          {c.screens.every((x) => x.level === "ok") && (
                            <span className={`rounded border px-1.5 py-0.5 text-[11px] ${LEVEL.ok}`}>all clear</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {selected && (
            <aside className="space-y-3">
              {!d ? (
                <div className="rounded-xl border border-zinc-800 p-4 text-sm text-zinc-500">Loading evidence…</div>
              ) : (
                <>
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="text-lg font-semibold text-white">{d.symbol}</div>
                        <div className="text-xs text-zinc-500">{d.name}</div>
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        <span className="num text-zinc-400">
                          {d.mint.slice(0, 4)}…{d.mint.slice(-4)}
                        </span>
                        <button onClick={() => navigator.clipboard.writeText(d.mint)} className="text-zinc-500 hover:text-white" title="Copy mint">
                          <CopyIcon />
                        </button>
                      </div>
                    </div>
                    {d.setups.map((x) => (
                      <div key={x.setup} className="mt-3 rounded-lg border border-zinc-800 p-2.5 text-xs">
                        <div className={`mb-1 font-semibold ${x.status === "fire" ? "text-emerald-300" : "text-violet-300"}`}>
                          {x.status === "fire" ? "Firing" : "Armed"}: {SETUP_LABEL[x.setup] ?? x.setup}
                        </div>
                        {[...x.structure, ...x.trigger].map((k) => (
                          <div key={k.label} className="flex justify-between gap-2">
                            <span className={k.ok ? "text-zinc-300" : "text-zinc-500"}>
                              {k.ok ? "✓" : "✗"} {k.label}
                            </span>
                            <span className="num text-zinc-500">{k.value}</span>
                          </div>
                        ))}
                      </div>
                    ))}
                    <div className="mt-3 space-y-1.5">
                      {d.screens.map((x) => (
                        <div key={x.id} className="flex items-start gap-2 text-xs">
                          <span className={`shrink-0 rounded border px-1.5 py-0.5 ${LEVEL[x.level]}`}>{x.level}</span>
                          <span className="text-zinc-300">
                            <b className="font-medium text-white">{x.label}:</b> {x.detail}
                          </span>
                        </div>
                      ))}
                    </div>
                    {d.social?.text && (
                      <blockquote className="mt-3 border-l-2 border-zinc-700 pl-3 text-xs text-zinc-400">
                        {d.social.text.slice(0, 280)}
                        <div className="mt-1 text-zinc-600">
                          @{d.social.author} · {d.social.authorFollowers?.toLocaleString()} followers
                          {d.social.likes != null && ` · ${d.social.likes} likes`}
                        </div>
                      </blockquote>
                    )}
                  </div>

                  {d.features && (
                    <div className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-zinc-800 bg-zinc-800 text-xs">
                      {(["flow15s", "flow60s", "flow5m"] as const).map((k) => {
                        const f = d.features![k];
                        return (
                          <div key={k} className="space-y-0.5 bg-zinc-950 p-3">
                            <div className="text-[11px] uppercase text-zinc-500">{k.replace("flow", "")}</div>
                            <FlowCell f={f} />
                            <div className="num text-zinc-500">
                              new {(f.newBuyerShare * 100).toFixed(0)}% · med {f.medianBuySol.toFixed(2)}◎
                            </div>
                            <div className="num text-zinc-500">
                              max {f.maxBuySol.toFixed(2)}◎ · rt {(f.roundTripShare * 100).toFixed(0)}%
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {d.holdersReport && (
                    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-xs">
                      <div className="mb-1.5 flex justify-between text-[11px] uppercase text-zinc-500">
                        <span>Top holders (excl. curve/pool)</span>
                        <span>{d.holdersReport.totalHolders?.toLocaleString() ?? "?"} holders</span>
                      </div>
                      {d.holdersReport.top.slice(0, 8).map((h) => (
                        <div key={h.owner} className="num flex justify-between py-0.5">
                          <span className="text-zinc-400">
                            {h.owner.slice(0, 4)}…{h.owner.slice(-4)} {h.insider && <span className="text-rose-400">insider</span>}
                          </span>
                          <span className="text-zinc-300">{h.pct.toFixed(2)}%</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="max-h-80 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-xs">
                    <div className="mb-1.5 text-[11px] uppercase text-zinc-500">Live tape</div>
                    {d.recentTrades.map((t) => (
                      <div key={t.id} className="num flex justify-between py-0.5">
                        <span className={t.side === "buy" ? "text-emerald-400" : "text-rose-400"}>{t.side}</span>
                        <span className="text-zinc-300">{t.sol.toFixed(3)}◎</span>
                        <span className="text-zinc-500">
                          {t.wallet.slice(0, 4)}…{t.wallet.slice(-4)}
                        </span>
                        <span className="text-zinc-600">{fmtAge(t.ts)}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
