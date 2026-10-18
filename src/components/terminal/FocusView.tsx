"use client";

import { CopyIcon, GlobeIcon, TelegramIcon, XIcon } from "../Icons";
import PriceChart from "../PriceChart";
import { AnalysisCard, DecisionCard } from "../research/ResearchCards";
import TokenIcon from "../TokenIcon";
import { useTerminal } from "./data";
import {
  coinImage,
  LANE_LABEL,
  LANE_TONE,
  SCREEN_TONE,
  SETUP_LABEL,
  solSigned,
  VERDICT_TONE,
  type CoinDetail,
  type Flow,
  type WatchedCoin,
} from "@/lib/agent";
import { fmtAge, fmtCompact, fmtPrice, pnlColor } from "@/lib/format";
import { usePolling } from "@/lib/hooks";
import type { ResearchReport } from "@/lib/research-types";

type Tone = "ok" | "warn" | "bad" | "info" | "idle" | "live";
const TONE: Record<Tone, string> = {
  ok: "text-emerald-400",
  warn: "text-amber-400",
  bad: "text-rose-400",
  info: "text-violet-300",
  idle: "text-zinc-600",
  live: "text-sky-400",
};

type Step = { id: string; label: string; value: string; tone: Tone };

function Pipeline({ steps, open, onOpen }: { steps: Step[]; open: string[]; onOpen: (id: string) => void }) {
  return (
    <ol className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-line bg-line lg:grid-cols-6">
      {steps.map((s, i) => (
        <li key={s.id}>
          <button
            onClick={() => onOpen(s.id)}
            className={`flex h-full w-full flex-col gap-1 px-3 py-2 text-left transition-colors ${open.includes(s.id) ? "bg-panel-2" : "bg-panel hover:bg-panel-2"}`}
          >
            <span className="flex items-center gap-1.5">
              <span className="num text-[10px] text-zinc-600">{i + 1}</span>
              <span className="label">{s.label}</span>
              <span className={`dot ml-auto ${TONE[s.tone]}`} style={{ width: 6, height: 6 }} />
            </span>
            <span className={`truncate text-[12px] ${s.tone === "idle" ? "text-zinc-500" : "text-zinc-100"}`} title={s.value}>
              {s.value}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function Section({ id, title, summary, open, onToggle, children }: { id: string; title: string; summary: React.ReactNode; open: boolean; onToggle: (id: string) => void; children: React.ReactNode }) {
  return (
    <section id={`section-${id}`} className="scroll-mt-2 rounded-lg border border-line bg-panel">
      <button onClick={() => onToggle(id)} className="flex w-full items-center gap-3 px-3 py-2 text-left">
        <span className={`text-[10px] text-zinc-500 transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
        <span className="label w-36 shrink-0">{title}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-400">{summary}</span>
      </button>
      {open && <div className="border-t border-line px-3 py-3">{children}</div>}
    </section>
  );
}

function FlowBox({ label, f }: { label: string; f: Flow }) {
  const total = f.buySol + f.sellSol;
  return (
    <div className="rounded-md border border-line p-2.5 text-[11px]">
      <div className="label">{label}</div>
      <div className={`num mt-1 text-sm ${pnlColor(f.netSol)}`}>
        {f.netSol > 0 ? "+" : ""}
        {f.netSol.toFixed(2)}◎ net
      </div>
      <div className="num text-zinc-500">
        {f.buyers} buyers · {f.sellers} sellers · {total ? Math.round((f.buySol / total) * 100) : 0}% buys
      </div>
      <div className="num text-zinc-500">
        new {(f.newBuyerShare * 100).toFixed(0)}% · median {f.medianBuySol.toFixed(2)}◎
      </div>
    </div>
  );
}

const ago = (ts: number) => `${fmtAge(ts)} ago`;
const fmtMin = (m: number) => (m >= 90 ? `${(m / 60).toFixed(1)}h` : `${Math.round(m)}m`);

export default function FocusView({ mint, open, onToggle }: { mint: string | null; open: string[]; onToggle: (id: string) => void }) {
  const { state, portfolio } = useTerminal();
  const { data: d } = usePolling<CoinDetail>(mint ? `/api/agent/coin/${mint}` : null, 2_500);
  const researchOpen = open.includes("research");
  const { data: research } = usePolling<ResearchReport>(mint && researchOpen ? `/api/agent/research?mint=${mint}` : null, 10_000);

  if (!mint) return <div className="flex h-full items-center justify-center text-sm text-zinc-500">Select a coin from the watchlist.</div>;
  if (!d || ("mint" in d && d.mint !== mint)) return <div className="flex h-full items-center justify-center text-sm text-zinc-500">Loading…</div>;

  const live: (WatchedCoin & Extract<CoinDetail, { tracked: true }>) | null = d.tracked ? d : null;
  const symbol = d.symbol ?? `${mint.slice(0, 4)}…`;
  const position = portfolio?.open.find((p) => p.account === "agent" && p.mint === mint);
  const closed = portfolio?.closed.filter((c) => c.account === "agent" && c.mint === mint) ?? [];
  const decisions = portfolio?.decisions.filter((x) => x.mint === mint) ?? [];
  const realized = closed.reduce((a, c) => a + c.pnlSol, 0);
  const f = live?.features ?? null;
  const vetoes = live?.screens.filter((x) => x.level === "veto") ?? [];
  const warns = live?.screens.filter((x) => x.level === "warn") ?? [];
  const best = live?.setups[0];
  const an = live?.analysis ?? null;
  const anFresh = !!an && an.expiresAt > Date.now();
  const researching = state?.analyst.running === symbol;

  // How the agent is processing this coin, step by step; each step opens its detail.
  const steps: Step[] = [
    {
      id: "flow",
      label: "Watch",
      value: live ? `${live.lane ? LANE_LABEL[live.lane] : live.stage} · ${fmtAge(live.createdAt)}` : "Not watched now",
      tone: live ? "live" : "idle",
    },
    {
      id: "screens",
      label: "Screens",
      value: !live ? "–" : vetoes.length ? `${vetoes.length} veto · ${vetoes[0].label}` : warns.length ? `${warns.length} warning${warns.length > 1 ? "s" : ""}` : "All clear",
      tone: !live ? "idle" : vetoes.length ? "bad" : warns.length ? "warn" : "ok",
    },
    {
      id: "setups",
      label: "Setup",
      value: !best ? "No setup" : best.status === "fire" ? `Firing · ${SETUP_LABEL[best.setup]}` : `Armed ${best.trigger.filter((k) => k.ok).length}/${best.trigger.length}`,
      tone: !best ? "idle" : best.status === "fire" ? "ok" : "info",
    },
    {
      id: "research",
      label: "Research",
      value: researching ? "Codex researching…" : an ? `${an.verdict} ×${an.conviction.toFixed(2)}${anFresh ? "" : " (expired)"}` : "Not researched",
      tone: researching ? "live" : !an ? "idle" : an.verdict === "reject" ? "bad" : an.verdict === "approve" ? "ok" : "warn",
    },
    {
      id: "decision",
      label: "Decision",
      value: decisions[0] ? (decisions[0].take ? `Buy ${decisions[0].sizeSol.toFixed(3)}◎` : `Pass · ${decisions[0].reasons[0] ?? ""}`) : "None yet",
      tone: !decisions[0] ? "idle" : decisions[0].take ? "ok" : "warn",
    },
    {
      id: "position",
      label: "Position",
      value: position ? `Open ${position.unrealizedSol != null ? solSigned(position.unrealizedSol) : ""}` : closed.length ? `Closed ${solSigned(realized)}` : "Flat",
      tone: position ? ((position.unrealizedSol ?? 0) >= 0 ? "ok" : "bad") : closed.length ? (realized >= 0 ? "ok" : "bad") : "idle",
    },
  ];

  const openStep = (id: string) => {
    if (!open.includes(id)) onToggle(id);
    requestAnimationFrame(() => document.getElementById(`section-${id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  };

  return (
    <div className="space-y-3 p-3">
      {/* Coin header */}
      <div className="flex flex-wrap items-center gap-3">
        <TokenIcon src={coinImage(mint)} symbol={symbol} size={40} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-xl font-semibold tracking-tight text-white">{symbol}</h2>
            {live?.lane && <span className={`rounded border border-line px-1.5 text-[10px] font-semibold ${LANE_TONE[live.lane]}`}>{LANE_LABEL[live.lane]}</span>}
            {live?.held && <span className="rounded bg-emerald-500/15 px-1.5 text-[10px] font-semibold text-emerald-300">HOLDING</span>}
          </div>
          <div className="truncate text-xs text-zinc-500">{d.name}</div>
        </div>
        {live?.quote && (
          <div className="num ml-2 leading-tight">
            <div className="text-lg text-white">{fmtPrice(live.quote.priceUsd)}</div>
            <div className="text-[11px] text-zinc-500">
              mcap {fmtCompact(live.quote.mcapUsd)}
              {live.quote.liquidityUsd > 0 && ` · liq ${fmtCompact(live.quote.liquidityUsd)}`}
              {f && ` · ${(f.drawdown * 100).toFixed(0)}% off ${f.highScope === "observed" ? "observed high" : "ATH"}`}
              {f?.migratedAgeMin != null && ` · migrated ${fmtMin(f.migratedAgeMin)} ago`}
            </div>
          </div>
        )}
        <div className="ml-auto flex items-center gap-3 text-zinc-500">
          {d.socials?.twitter && (
            <a href={d.socials.twitter} target="_blank" rel="noreferrer noopener" className="hover:text-white" title="X / Twitter">
              <XIcon className="h-4 w-4" />
            </a>
          )}
          {d.socials?.telegram && (
            <a href={d.socials.telegram} target="_blank" rel="noreferrer noopener" className="hover:text-white" title="Telegram">
              <TelegramIcon className="h-4 w-4" />
            </a>
          )}
          {d.socials?.website && (
            <a href={d.socials.website} target="_blank" rel="noreferrer noopener" className="hover:text-white" title="Website">
              <GlobeIcon className="h-4 w-4" />
            </a>
          )}
          <a href={`https://pump.fun/coin/${mint}`} target="_blank" rel="noreferrer noopener" className="text-[11px] hover:text-white">
            pump.fun ↗
          </a>
          <button onClick={() => navigator.clipboard.writeText(mint)} className="hover:text-white" title="Copy contract address">
            <CopyIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      {d.pairAddress && (
        <div className="overflow-hidden rounded-lg border border-line bg-panel [&>div]:rounded-none [&>div]:border-0">
          <PriceChart pairAddress={d.pairAddress} livePrice={live?.quote?.priceUsd ?? 0} markers={d.fills.map((x) => ({ ts: x.ts, side: x.side }))} />
        </div>
      )}

      <Pipeline steps={steps} open={open} onOpen={openStep} />

      {!live && (
        <div className="rounded-lg border border-line bg-panel p-3 text-xs text-zinc-500">
          The agent isn&apos;t watching this coin right now, so live evidence isn&apos;t available.
        </div>
      )}

      <div className="space-y-2">
        <Section
          id="position"
          title="Agent on this coin"
          open={open.includes("position")}
          onToggle={onToggle}
          summary={
            position
              ? `Holding ${position.costSol.toFixed(3)}◎ · ${SETUP_LABEL[position.setup] ?? position.setup} · stop ${(((position.stopSol / position.entryPriceSol) - 1) * 100).toFixed(0)}%`
              : closed.length
                ? `${closed.length} closed · realized ${solSigned(realized)}`
                : "No trades on this coin"
          }
        >
          {d.fills.length === 0 && <p className="text-xs text-zinc-500">No fills yet.</p>}
          <div className="divide-y divide-line text-xs">
            {[...d.fills].reverse().map((x, i) => (
              <div key={`${x.ts}-${i}`} className="num flex gap-4 py-1.5">
                <span className={x.side === "buy" ? "text-emerald-400" : "text-rose-400"}>{x.side.toUpperCase()}</span>
                <span className="text-zinc-300">{x.sol.toFixed(3)}◎</span>
                <span className="text-zinc-500">{x.reason ?? ""}</span>
                <span className="ml-auto text-zinc-600">{ago(x.ts)}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section
          id="decision"
          title="Decisions"
          open={open.includes("decision")}
          onToggle={onToggle}
          summary={decisions[0] ? `${decisions[0].take ? "Bought" : "Passed"} ${ago(decisions[0].at)} · ${decisions.length} on this coin` : "The agent hasn't decided on this coin"}
        >
          {!decisions.length && <p className="text-xs text-zinc-500">Decisions appear when a setup fires.</p>}
          <div className="space-y-2">
            {decisions.map((x, i) => (
              <div key={`${x.at}-${i}`} className="rounded-md border border-line p-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${x.take ? "bg-emerald-500/15 text-emerald-300" : "bg-zinc-800 text-zinc-400"}`}>
                    {x.take ? "BUY" : "PASS"}
                  </span>
                  <span className="text-zinc-300">{SETUP_LABEL[x.setup] ?? x.setup}</span>
                  <span className="num ml-auto text-zinc-600">{ago(x.at)}</span>
                </div>
                <div className="num mt-1 text-zinc-500">
                  size {x.sizeSol.toFixed(3)}◎ · {x.mode === "explore" ? `exploring (${x.n}/15)` : `benchmark ${x.n} trades`} · analyst {x.analyst.verdict} ×
                  {x.analyst.conviction.toFixed(2)}
                  {x.regime && ` · regime ${x.regime.level}`}
                </div>
                {x.costs && (
                  <div className="num mt-0.5 text-zinc-500">
                    round trip {(x.costs.roundTripCostPct * 100).toFixed(1)}% · impact {(x.costs.entryImpact * 100).toFixed(2)}% · TP1 net{" "}
                    <span className="text-emerald-300/80">
                      {x.costs.tp1NetSol >= 0 ? "+" : ""}
                      {x.costs.tp1NetSol.toFixed(4)}◎
                    </span>{" "}
                    · stop net <span className="text-rose-300/80">{x.costs.stopNetSol.toFixed(4)}◎</span> · net R/R {x.costs.netRewardRisk.toFixed(2)}
                  </div>
                )}
                {x.reasons.length > 0 && <div className="mt-0.5 text-zinc-400">{x.reasons.join(" · ")}</div>}
                {x.essentials && x.essentials.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {x.essentials.map((e) => (
                      <span
                        key={e.id}
                        title={e.detail}
                        className={`rounded border px-1.5 py-0.5 text-[10px] ${e.ok ? "border-emerald-900 text-emerald-300/80" : "border-amber-900 text-amber-300"}`}
                      >
                        {e.ok ? "✓" : "?"} {e.label}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Section>

        {live && (
          <Section
            id="setups"
            title="Setup checks"
            open={open.includes("setups")}
            onToggle={onToggle}
            summary={best ? `${best.status === "fire" ? "Firing" : "Armed"}: ${SETUP_LABEL[best.setup]} · ${best.trigger.filter((k) => !k.ok).map((k) => k.label).join(", ") || "all checks pass"}` : "No setup has formed"}
          >
            {!live.setups.length && <p className="text-xs text-zinc-500">None of the five setups has formed its structure on this coin.</p>}
            <div className="grid gap-3 md:grid-cols-2">
              {live.setups.map((x) => (
                <div key={x.setup} className="text-xs">
                  <div className={`mb-1 font-semibold ${x.status === "fire" ? "text-emerald-300" : "text-violet-300"}`}>
                    {x.status === "fire" ? "Firing" : "Armed"}: {SETUP_LABEL[x.setup] ?? x.setup}
                  </div>
                  {x.episode && (
                    <div className="num mb-1 text-[11px] text-zinc-500">
                      {x.episode.state === "cooldown"
                        ? `Cooling down after a failed episode · signals resume ${x.episode.cooldownUntil ? `in ${fmtMin(Math.max(0, (x.episode.cooldownUntil - Date.now()) / 60_000))}` : "soon"}`
                        : `Armed ${ago(x.episode.armedAt)}${x.episode.firedAt ? ` · fired ${ago(x.episode.firedAt)}` : ""}`}
                    </div>
                  )}
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
            </div>
          </Section>
        )}

        {live && (
          <Section
            id="screens"
            title="Risk screens"
            open={open.includes("screens")}
            onToggle={onToggle}
            summary={
              vetoes.length || warns.length
                ? [...vetoes, ...warns].map((x) => `${x.level === "veto" ? "✗" : "!"} ${x.label}`).join(" · ")
                : `${live.screens.filter((x) => x.level === "ok").length} checks clear`
            }
          >
            <div className="grid gap-1.5 md:grid-cols-2">
              {[...live.screens]
                .sort((a, b) => ["veto", "warn", "unknown", "ok"].indexOf(a.level) - ["veto", "warn", "unknown", "ok"].indexOf(b.level))
                .map((x) => (
                  <div key={x.id} className="flex items-start gap-2 text-xs">
                    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${SCREEN_TONE[x.level]}`}>{x.status === "stale" ? "stale" : x.level}</span>
                    <span className="text-zinc-300">
                      <b className="font-medium text-white">{x.label}:</b> {x.detail}
                      {x.observedAt && x.status !== "stale" && <span className="num text-zinc-600"> · {ago(x.observedAt)}</span>}
                    </span>
                  </div>
                ))}
            </div>
          </Section>
        )}

        <Section
          id="research"
          title="Research"
          open={researchOpen}
          onToggle={onToggle}
          summary={
            researching
              ? "Codex is researching this coin now…"
              : an
                ? `${an.verdict} ×${an.conviction.toFixed(2)} · ${an.narrative}`
                : "No Codex report yet — the agent researches coins as setups develop"
          }
        >
          {an && (
            <div className={`mb-3 rounded-md border p-3 text-xs ${VERDICT_TONE[an.verdict]}`}>
              <div className="flex justify-between font-semibold">
                <span>
                  {an.verdict} · {an.narrativeType} · ×{an.conviction.toFixed(2)}
                </span>
                <span className="font-normal opacity-70">{anFresh ? `valid ${Math.round((an.expiresAt - Date.now()) / 60_000)}m` : "expired"}</span>
              </div>
              <p className="mt-1 text-zinc-200">{an.thesis}</p>
              {an.redFlags.slice(0, 3).map((r) => (
                <p key={r} className="text-rose-300">
                  − {r}
                </p>
              ))}
              {an.greenFlags.slice(0, 3).map((g) => (
                <p key={g} className="text-emerald-300">
                  + {g}
                </p>
              ))}
            </div>
          )}
          {!research && <p className="text-xs text-zinc-500">Loading research history…</p>}
          {research && !research.analyses.length && !research.decisions.length && (
            <p className="text-xs text-zinc-500">No Codex reports or linked decisions for this coin in the last 7 days.</p>
          )}
          {research && (
            <div className="space-y-3">
              {research.analyses.map((a) => (
                <AnalysisCard key={a.id} a={a} decisions={research.decisions} now={research.now} />
              ))}
              {research.decisions.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-zinc-300">Decision audit ({research.decisions.length})</summary>
                  <div className="mt-2 space-y-2">
                    {research.decisions.map((x) => (
                      <DecisionCard key={x.id} d={x} />
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}
        </Section>

        {live && (
          <Section
            id="holders"
            title="Holders & developer"
            open={open.includes("holders")}
            onToggle={onToggle}
            summary={[
              live.holdersReport ? `top-10 ${live.holdersReport.top.slice(0, 10).reduce((a, h) => a + h.pct, 0).toFixed(1)}%` : "holders pending",
              live.funding ? `${live.funding.fresh} fresh · cluster ${live.funding.topClusterPct.toFixed(1)}%` : "wallets pending",
              live.dev ? `dev ${live.dev.launches}${live.dev.capped ? "+" : ""} launches · ${live.dev.successes} hits` : "dev pending",
            ].join(" · ")}
          >
            <div className="grid gap-4 md:grid-cols-2">
              <div className="text-xs">
                <div className="label mb-1">Top holders · {live.holdersReport?.totalHolders?.toLocaleString() ?? "?"} total</div>
                {live.holdersReport?.top.slice(0, 10).map((h) => (
                  <div key={h.owner} className="num flex justify-between py-0.5">
                    <span className="text-zinc-400">
                      {h.owner.slice(0, 4)}…{h.owner.slice(-4)} {h.insider && <span className="text-rose-400">insider</span>}
                    </span>
                    <span className="text-zinc-300">{h.pct.toFixed(2)}%</span>
                  </div>
                ))}
              </div>
              <div className="space-y-3 text-xs">
                <div>
                  <div className="label mb-1">Top-holder wallets</div>
                  {live.funding ? (
                    <>
                      <p className="text-zinc-300">
                        {live.funding.fresh} of {live.funding.checked} under a day old ({live.funding.freshPct.toFixed(1)}% of supply)
                      </p>
                      {live.funding.clusters.length ? (
                        live.funding.clusters.map((c) => (
                          <p key={c.funder} className="text-amber-300">
                            {c.wallets.length} wallets share funder {c.funder.slice(0, 4)}…{c.funder.slice(-4)} · {c.pct.toFixed(1)}%
                          </p>
                        ))
                      ) : (
                        <p className="text-zinc-500">No shared (non-exchange) funders.</p>
                      )}
                    </>
                  ) : (
                    <p className="text-zinc-500">Wallet checks pending.</p>
                  )}
                </div>
                <div>
                  <div className="label mb-1">Developer</div>
                  {live.dev ? (
                    <p className="text-zinc-300">
                      {live.dev.launches}
                      {live.dev.capped ? "+" : ""} prior launches ({live.dev.launches24h} in 24h) · {live.dev.graduated} graduated · best ATH $
                      {Math.round(live.dev.bestAthUsd / 1000)}k · {live.dev.died} died
                      {live.dev.resolved !== undefined && (
                        <span className="block text-zinc-500">
                          {live.dev.successes} of {live.dev.resolved} resolved launches succeeded · success rate ≥ {((live.dev.successLowerBound ?? 0) * 100).toFixed(0)}% (95%)
                        </span>
                      )}
                    </p>
                  ) : (
                    <p className="text-zinc-500">Not looked up yet.</p>
                  )}
                </div>
              </div>
            </div>
          </Section>
        )}

        {f && (
          <Section
            id="flow"
            title="Order flow"
            open={open.includes("flow")}
            onToggle={onToggle}
            summary={`60s: ${f.flow60s.netSol >= 0 ? "+" : ""}${f.flow60s.netSol.toFixed(2)}◎ · ${f.flow60s.buyers} buyers / ${f.flow60s.sellers} sellers · exhaustion ${
              f.exhaustion === null ? "idle" : `${Math.round(f.exhaustion * 100)}`
            }`}
          >
            <div className="grid gap-2 sm:grid-cols-3">
              <FlowBox label="Last 15s" f={f.flow15s} />
              <FlowBox label="Last 60s" f={f.flow60s} />
              <FlowBox label="Last 5m" f={f.flow5m} />
            </div>
            {f.tapeFromLaunch && f.cohortsReliable === false && (
              <p className="mt-3 text-xs text-amber-300/80">Tape has {f.tapeGaps} gap(s) since launch; cohort holdings below may be understated.</p>
            )}
            {f.tapeFromLaunch && (
              <div className="num mt-3 flex flex-wrap gap-x-4 text-xs text-zinc-400">
                <span>dev {f.cohorts.dev.heldPct.toFixed(1)}%</span>
                <span>snipers {f.cohorts.snipers.heldPct.toFixed(1)}%</span>
                <span>bundles {f.cohorts.bundles.heldPct.toFixed(1)}%</span>
                <span>early {f.cohorts.early.heldPct.toFixed(1)}%</span>
              </div>
            )}
          </Section>
        )}

        {live && (
          <Section
            id="tape"
            title="Live tape"
            open={open.includes("tape")}
            onToggle={onToggle}
            summary={live.recentTrades[0] ? `last ${live.recentTrades[0].side} ${live.recentTrades[0].sol.toFixed(3)}◎ ${ago(live.recentTrades[0].ts)}` : "No trades read yet"}
          >
            <div className="scroll-thin max-h-72 overflow-y-auto text-xs">
              {live.recentTrades.map((t) => (
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
          </Section>
        )}
      </div>
    </div>
  );
}
