"use client";

import { CopyIcon, GlobeIcon, TelegramIcon, XIcon } from "../Icons";
import PriceChart from "../PriceChart";
import { AnalysisCard, DecisionCard } from "../research/ResearchCards";
import TokenIcon from "../TokenIcon";
import { useTerminal } from "./data";
import { TraderCard } from "./Traders";
import { ACCENT, Metric, numeric, Pill, Progress, Section, TONE_TEXT, type Tone } from "./ui";
import {
  coinImage,
  LANE_LABEL,
  LANE_TONE,
  SETUP_LABEL,
  solSigned,
  type CoinDetail,
  type Flow,
  type WatchedCoin,
} from "@/lib/agent";
import { fmtAge, fmtCompact, fmtPrice, pnlColor } from "@/lib/format";
import { usePolling } from "@/lib/hooks";
import type { ResearchReport } from "@/lib/research-types";

const TONE: Record<Tone, string> = {
  ok: "text-emerald-400",
  warn: "text-amber-400",
  bad: "text-rose-400",
  info: "text-violet-300",
  idle: "text-zinc-600",
  live: "text-sky-400",
};

const countOk = (checks: { ok: boolean }[]) => checks.filter((k) => k.ok).length;
const screenCount = (screens: { level: string; status?: string }[], level: string) => screens.filter((x) => x.level === level && x.status !== "stale").length;
const SCREEN_GROUPS: { key: string; title: string; tone: Tone }[] = [
  { key: "veto", title: "Vetoes", tone: "bad" },
  { key: "warn", title: "Warnings", tone: "warn" },
  { key: "stale", title: "Stale data", tone: "idle" },
  { key: "unknown", title: "Not verified", tone: "idle" },
  { key: "ok", title: "Clear", tone: "ok" },
];
/** First clause of a decision reason, for one-line summaries. */
const shortReason = (r: string) => (r.length > 60 ? `${r.split(":")[0]}` : r);

function FlagList({ title, tone, items }: { title: string; tone: Tone; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <div className={`mb-0.5 text-[10px] font-semibold uppercase tracking-wide ${TONE_TEXT[tone]}`}>{title}</div>
      <ul className="space-y-0.5">
        {items.slice(0, 4).map((x) => (
          <li key={x} className="flex gap-1.5 text-zinc-300">
            <span className={TONE_TEXT[tone]}>{tone === "bad" ? "−" : "+"}</span>
            <span>{x}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

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
  const lastTrade = live?.recentTrades[0];
  const traders = live?.traders ?? [];
  const tradersHolding = traders.filter((t) => t.holdingPct >= 5);
  // Chart markers: the agent's fills, plus watched/discovered traders' trades labelled with their initials.
  const markers = [
    ...d.fills.map((x) => ({ ts: x.ts, side: x.side })),
    ...traders.flatMap((t) =>
      t.actions.map((a) => ({
        ts: a.ts,
        side: a.side,
        label: (t.name ?? t.address).replace(/[^A-Za-z0-9]/g, "").slice(0, 3),
        color: t.source === "watching" ? "#fbbf24" : "#38bdf8",
      })),
    ),
  ];
  const top10 = live?.holdersReport?.top.slice(0, 10).reduce((a, h) => a + h.pct, 0) ?? 0;
  const holderScreens = live?.screens.filter((x) => ["top10", "insiders", "fresh", "funding", "devhistory", "dev", "authority"].includes(x.id)) ?? [];
  const holderTone: Tone = !live?.holdersReport
    ? "idle"
    : holderScreens.some((x) => x.level === "veto")
      ? "bad"
      : holderScreens.some((x) => x.level === "warn")
        ? "warn"
        : "ok";

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
          <PriceChart pairAddress={d.pairAddress} livePrice={live?.quote?.priceUsd ?? 0} markers={markers} />
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
          tone={position ? ((position.unrealizedSol ?? 0) >= 0 ? "ok" : "bad") : closed.length ? (realized >= 0 ? "ok" : "bad") : "idle"}
          badge={position ? "Holding" : closed.length ? "Closed" : "Flat"}
          chips={
            position
              ? [
                  { label: "size", value: `${position.costSol.toFixed(3)}◎` },
                  { label: "setup", value: SETUP_LABEL[position.setup] ?? position.setup },
                  { label: "stop", value: `${((position.stopSol / position.entryPriceSol - 1) * 100).toFixed(0)}%`, tone: "bad" },
                  ...(position.unrealizedSol != null ? [{ label: "P&L", value: solSigned(position.unrealizedSol), tone: (position.unrealizedSol >= 0 ? "ok" : "bad") as Tone }] : []),
                ]
              : closed.length
                ? [
                    { label: "trades", value: closed.length },
                    { label: "realized", value: solSigned(realized), tone: realized >= 0 ? "ok" : "bad" },
                  ]
                : [{ value: "No trades on this coin", tone: "idle" }]
          }
        >
          {d.fills.length === 0 && <p className="text-xs text-zinc-500">No fills yet.</p>}
          <div className="divide-y divide-line text-xs">
            {[...d.fills].reverse().map((x, i) => (
              <div key={`${x.ts}-${i}`} className="num flex items-center gap-4 py-1.5">
                <Pill tone={x.side === "buy" ? "ok" : "bad"} icon={false}>
                  {x.side}
                </Pill>
                <span className="text-zinc-200">{x.sol.toFixed(3)}◎</span>
                <span className="text-zinc-400">{x.reason ?? ""}</span>
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
          tone={!decisions[0] ? "idle" : decisions[0].take ? "ok" : "warn"}
          badge={!decisions[0] ? "None" : decisions[0].take ? "Buy" : "Pass"}
          chips={
            decisions[0]
              ? [
                  { label: "last", value: ago(decisions[0].at) },
                  { label: "total", value: decisions.length },
                  ...(decisions[0].take
                    ? [{ label: "size", value: `${decisions[0].sizeSol.toFixed(3)}◎`, tone: "ok" as Tone }]
                    : decisions[0].reasons[0]
                      ? [{ label: "why", value: shortReason(decisions[0].reasons[0]), tone: "warn" as Tone }]
                      : []),
                ]
              : [{ value: "Decides only when a setup fires", tone: "idle" }]
          }
        >
          {!decisions.length && <p className="text-xs text-zinc-500">Decisions appear when a setup fires.</p>}
          <div className="space-y-3">
            {decisions.map((x, i) => (
              <div key={`${x.at}-${i}`} className={`rounded-md border border-l-2 border-line p-3 text-xs ${ACCENT[x.take ? "ok" : "warn"]}`}>
                <div className="flex items-center gap-2">
                  <Pill tone={x.take ? "ok" : "warn"} size="md">
                    {x.take ? "Buy" : "Pass"}
                  </Pill>
                  <span className="text-[13px] text-zinc-100">{SETUP_LABEL[x.setup] ?? x.setup}</span>
                  <span className="num ml-auto text-zinc-500">{ago(x.at)}</span>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                  <Metric label={x.take ? "Size" : "Proposed size"} value={`${x.sizeSol.toFixed(3)}◎`} tone={x.take ? "ok" : undefined} />
                  <Metric label="Evidence" value={x.mode === "explore" ? `Exploring ${x.n}/15` : `${x.n} trades`} />
                  <Metric
                    label="Analyst"
                    value={`${x.analyst.verdict} ×${x.analyst.conviction.toFixed(2)}`}
                    tone={x.analyst.verdict === "reject" ? "bad" : x.analyst.verdict === "approve" ? "ok" : undefined}
                  />
                  <Metric label="Regime" value={x.regime?.level ?? "–"} tone={x.regime?.level === "bad" ? "bad" : x.regime?.level === "caution" ? "warn" : undefined} />
                </div>
                {x.costs && (
                  <div className="mt-1.5 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                    <Metric label="Round-trip cost" value={`${(x.costs.roundTripCostPct * 100).toFixed(1)}%`} hint={`Own price impact ${(x.costs.entryImpact * 100).toFixed(2)}%`} />
                    <Metric label="Net at TP1" value={`${x.costs.tp1NetSol >= 0 ? "+" : ""}${x.costs.tp1NetSol.toFixed(4)}◎`} tone="ok" />
                    <Metric label="Net at stop" value={`${x.costs.stopNetSol.toFixed(4)}◎`} tone="bad" />
                    <Metric label="Net reward/risk" value={x.costs.netRewardRisk.toFixed(2)} tone={x.costs.netRewardRisk >= 1 ? "ok" : "warn"} />
                  </div>
                )}
                {x.reasons.length > 0 && (
                  <div className="mt-2">
                    <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">Why it passed</div>
                    <ul className="space-y-1">
                      {x.reasons.map((r) => (
                        <li key={r} className="flex gap-2 text-zinc-300">
                          <span className="text-amber-400">✕</span>
                          <span>{r}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {x.essentials && x.essentials.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    <span className="mr-1 text-[10px] uppercase tracking-wide text-zinc-500">Required evidence</span>
                    {x.essentials.map((e) => (
                      <span key={e.id} title={e.detail}>
                        <Pill tone={e.ok ? "ok" : "warn"}>{e.label}</Pill>
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
            tone={!best ? "idle" : best.status === "fire" ? "ok" : best.episode?.state === "cooldown" ? "idle" : "info"}
            badge={!best ? "None" : best.status === "fire" ? "Firing" : best.episode?.state === "cooldown" ? "Cooldown" : `Armed ${countOk(best.trigger)}/${best.trigger.length}`}
            chips={
              best
                ? [
                    { value: SETUP_LABEL[best.setup] ?? best.setup },
                    ...(best.episode && best.episode.state !== "cooldown" ? [{ label: "armed", value: ago(best.episode.armedAt) }] : []),
                    ...best.trigger.filter((k) => !k.ok).slice(0, 2).map((k) => ({ label: "waiting", value: k.label, tone: "warn" as Tone })),
                  ]
                : [{ value: "No setup has formed", tone: "idle" }]
            }
          >
            {!live.setups.length && <p className="text-xs text-zinc-500">None of the five setups has formed its structure on this coin.</p>}
            <div className="grid gap-3 md:grid-cols-2">
              {live.setups.map((x) => {
                const all = [...x.structure, ...x.trigger];
                const tone: Tone = x.status === "fire" ? "ok" : x.episode?.state === "cooldown" ? "idle" : "info";
                return (
                  <div key={x.setup} className={`rounded-md border border-l-2 border-line p-3 text-xs ${ACCENT[tone]}`}>
                    <div className="flex items-center gap-2">
                      <Pill tone={tone}>{x.status === "fire" ? "Firing" : x.episode?.state === "cooldown" ? "Cooldown" : "Armed"}</Pill>
                      <span className="text-[13px] text-zinc-100">{SETUP_LABEL[x.setup] ?? x.setup}</span>
                      <span className="num ml-auto text-zinc-400">
                        {countOk(all)}/{all.length}
                      </span>
                    </div>
                    <div className="mt-2">
                      <Progress done={countOk(all)} total={all.length} tone={tone} />
                    </div>
                    {x.episode && (
                      <div className="num mt-1.5 text-[11px] text-zinc-500">
                        {x.episode.state === "cooldown"
                          ? `Last episode failed · signals resume ${x.episode.cooldownUntil ? `in ${fmtMin(Math.max(0, (x.episode.cooldownUntil - Date.now()) / 60_000))}` : "soon"}`
                          : `Armed ${ago(x.episode.armedAt)}${x.episode.firedAt ? ` · fired ${ago(x.episode.firedAt)}` : ""}`}
                      </div>
                    )}
                    {[
                      { name: "Structure", checks: x.structure },
                      { name: "Trigger", checks: x.trigger },
                    ].map((g) => (
                      <div key={g.name} className="mt-2">
                        <div className="mb-0.5 text-[10px] uppercase tracking-wide text-zinc-500">{g.name}</div>
                        {g.checks.map((k) => (
                          <div key={k.label} className="flex justify-between gap-2 py-0.5">
                            <span className={k.ok ? "text-zinc-300" : "text-amber-200"}>
                              <span className={k.ok ? "text-emerald-400" : "text-amber-400"}>{k.ok ? "✓" : "✕"}</span> {k.label}
                            </span>
                            <span className={`${numeric(k.value) ? "num" : ""} text-right ${k.ok ? "text-zinc-500" : "text-amber-300/80"}`}>{k.value}</span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        {live && (
          <Section
            id="screens"
            title="Risk screens"
            open={open.includes("screens")}
            onToggle={onToggle}
            tone={vetoes.length ? "bad" : warns.length ? "warn" : "ok"}
            badge={vetoes.length ? `${vetoes.length} veto` : warns.length ? `${warns.length} warning${warns.length > 1 ? "s" : ""}` : "Clear"}
            chips={[
              ...[...vetoes, ...warns].slice(0, 3).map((x) => ({ value: x.label, tone: (x.level === "veto" ? "bad" : "warn") as Tone })),
              { label: "clear", value: screenCount(live.screens, "ok"), tone: "ok" },
              ...(screenCount(live.screens, "unknown") ? [{ label: "unknown", value: screenCount(live.screens, "unknown"), tone: "idle" as Tone }] : []),
            ]}
          >
            <div className="space-y-3">
              {SCREEN_GROUPS.map((g) => {
                const rows = live.screens.filter((x) => (x.status === "stale" ? "stale" : x.level) === g.key);
                if (!rows.length) return null;
                return (
                  <div key={g.key}>
                    <div className={`mb-1 text-[10px] font-semibold uppercase tracking-wide ${TONE_TEXT[g.tone]}`}>
                      {g.title} · {rows.length}
                    </div>
                    <div className="grid gap-1.5 md:grid-cols-2">
                      {rows.map((x) => (
                        <div key={x.id} className={`rounded-md border border-l-2 border-line px-2.5 py-1.5 text-xs ${ACCENT[g.tone]}`}>
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-zinc-100">{x.label}</span>
                            {x.observedAt && <span className="num ml-auto text-[10px] text-zinc-600">{ago(x.observedAt)}</span>}
                          </div>
                          <div className="mt-0.5 leading-snug text-zinc-400">{x.detail}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        {live && (
          <Section
            id="traders"
            title="Traders on this coin"
            open={open.includes("traders")}
            onToggle={onToggle}
            tone={!traders.length ? "idle" : tradersHolding.length ? "warn" : "info"}
            badge={!traders.length ? "None" : tradersHolding.length ? `${tradersHolding.length} holding` : `${traders.length} exited`}
            chips={
              traders.length
                ? traders.slice(0, 3).map((t) => ({
                    label: t.name ?? `${t.address.slice(0, 4)}…`,
                    value: `${t.multiple ? `${t.multiple.toFixed(2)}x` : "–"} · ${t.holdingPct.toFixed(0)}% held`,
                    tone: (t.multiple && t.multiple >= 1 ? "ok" : "bad") as Tone,
                  }))
                : [{ value: "No watched or discovered trader has traded this coin", tone: "idle" }]
            }
          >
            {!traders.length && (
              <p className="text-xs text-zinc-500">Add wallets in the Traders tab (dock, key 5). Discovered wallets appear here automatically when they trade.</p>
            )}
            <div className="grid gap-2 md:grid-cols-2">
              {traders.map((t) => (
                <TraderCard key={t.address} t={t} />
              ))}
            </div>
            {traders.length > 0 && (
              <p className="mt-2 text-[11px] text-zinc-500">
                Shown as evidence, not a signal: the agent doesn&apos;t copy these trades. &ldquo;What predicts winners&rdquo; measures whether their presence actually helped.
              </p>
            )}
          </Section>
        )}

        <Section
          id="research"
          title="Research"
          open={researchOpen}
          onToggle={onToggle}
          tone={researching ? "live" : !an ? "idle" : !anFresh ? "idle" : an.verdict === "reject" ? "bad" : an.verdict === "approve" ? "ok" : "warn"}
          badge={researching ? "Researching" : an ? an.verdict : "None"}
          chips={
            an
              ? [
                  { label: "size", value: `×${an.conviction.toFixed(2)}` },
                  { label: "narrative", value: an.narrativeType },
                  { value: anFresh ? `valid ${Math.round((an.expiresAt - Date.now()) / 60_000)}m` : "expired", tone: anFresh ? undefined : "idle" },
                ]
              : [{ value: researching ? "Codex is reading sources…" : "Researched as setups develop", tone: "idle" }]
          }
        >
          {an && (
            <div className={`mb-3 rounded-md border border-l-2 border-line p-3 text-xs ${ACCENT[an.verdict === "reject" ? "bad" : an.verdict === "approve" ? "ok" : "warn"]}`}>
              <div className="flex items-center gap-2">
                <Pill tone={an.verdict === "reject" ? "bad" : an.verdict === "approve" ? "ok" : "warn"} size="md">
                  {an.verdict} ×{an.conviction.toFixed(2)}
                </Pill>
                <span className="text-zinc-400">{an.narrativeType} narrative</span>
                <span className="ml-auto text-zinc-500">{anFresh ? `valid ${Math.round((an.expiresAt - Date.now()) / 60_000)}m` : "expired"}</span>
              </div>
              <p className="mt-2 text-[13px] leading-snug text-zinc-100">{an.narrative}</p>
              <p className="mt-1 leading-relaxed text-zinc-400">{an.thesis}</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <FlagList title="Against" tone="bad" items={an.redFlags} />
                <FlagList title="For" tone="ok" items={an.greenFlags} />
              </div>
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
            tone={holderTone}
            badge={holderTone === "bad" ? "Veto" : holderTone === "warn" ? "Caution" : holderTone === "idle" ? "Pending" : "Clear"}
            chips={[
              live.holdersReport ? { label: "top-10", value: `${top10.toFixed(1)}%`, tone: top10 >= 35 ? "bad" : top10 >= 25 ? "warn" : undefined } : { label: "holders", value: "pending", tone: "idle" },
              live.funding
                ? { label: "fresh wallets", value: `${live.funding.fresh}/${live.funding.checked}`, tone: live.funding.fresh >= 3 ? "warn" : undefined }
                : { label: "wallets", value: "pending", tone: "idle" },
              ...(live.funding ? [{ label: "cluster", value: `${live.funding.topClusterPct.toFixed(1)}%`, tone: (live.funding.topClusterPct >= 5 ? "warn" : undefined) as Tone | undefined }] : []),
              live.dev
                ? { label: "dev", value: `${live.dev.launches}${live.dev.capped ? "+" : ""} launches · ${live.dev.successes} hits` }
                : { label: "dev", value: "pending", tone: "idle" },
            ]}
          >
            <div className="grid gap-4 md:grid-cols-2">
              <div className="text-xs">
                <div className="label mb-1">Top holders · {live.holdersReport?.totalHolders?.toLocaleString() ?? "?"} total</div>
                {live.holdersReport?.top.slice(0, 10).map((h) => (
                  <div key={h.owner} className="num flex items-center gap-2 py-0.5">
                    <span className="w-24 text-zinc-400">
                      {h.owner.slice(0, 4)}…{h.owner.slice(-4)}
                    </span>
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-zinc-800">
                      <div className={`h-full ${h.insider ? "bg-rose-400" : "bg-zinc-500"}`} style={{ width: `${Math.min(100, h.pct * 5)}%` }} />
                    </div>
                    <span className="w-12 text-right text-zinc-300">{h.pct.toFixed(2)}%</span>
                    {h.insider && <Pill tone="bad" icon={false}>insider</Pill>}
                  </div>
                ))}
              </div>
              <div className="space-y-3 text-xs">
                <div>
                  <div className="label mb-1">Top-holder wallets</div>
                  {live.funding ? (
                    <div className="grid grid-cols-3 gap-1.5">
                      <Metric label="Under a day old" value={`${live.funding.fresh} of ${live.funding.checked}`} tone={live.funding.fresh >= 3 ? "warn" : undefined} />
                      <Metric label="Their supply" value={`${live.funding.freshPct.toFixed(1)}%`} />
                      <Metric label="Shared funder" value={`${live.funding.topClusterPct.toFixed(1)}%`} tone={live.funding.topClusterPct >= 5 ? "warn" : undefined} />
                    </div>
                  ) : (
                    <p className="text-zinc-500">Wallet checks pending.</p>
                  )}
                  {live.funding?.clusters.map((c) => (
                    <p key={c.funder} className="mt-1 text-amber-300">
                      {c.wallets.length} wallets share funder {c.funder.slice(0, 4)}…{c.funder.slice(-4)} · {c.pct.toFixed(1)}%
                    </p>
                  ))}
                </div>
                <div>
                  <div className="label mb-1">Developer</div>
                  {live.dev ? (
                    <>
                      <div className="grid grid-cols-3 gap-1.5">
                        <Metric label="Prior launches" value={`${live.dev.launches}${live.dev.capped ? "+" : ""}`} hint={`${live.dev.launches24h} in the last 24h`} />
                        <Metric label="Graduated" value={live.dev.graduated} />
                        <Metric label="Best ATH" value={`$${Math.round(live.dev.bestAthUsd / 1000)}k`} />
                      </div>
                      {live.dev.resolved !== undefined && (
                        <p className="mt-1 text-zinc-500">
                          {live.dev.successes} of {live.dev.resolved} resolved launches succeeded · success rate ≥ {((live.dev.successLowerBound ?? 0) * 100).toFixed(0)}% (95%)
                        </p>
                      )}
                    </>
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
            tone={f.flow60s.buyers + f.flow60s.sellers === 0 ? "idle" : f.flow60s.netSol > 0 ? "ok" : "bad"}
            badge={f.flow60s.buyers + f.flow60s.sellers === 0 ? "Quiet" : f.flow60s.netSol > 0 ? "Net buying" : "Net selling"}
            chips={[
              { label: "60s net", value: `${f.flow60s.netSol >= 0 ? "+" : ""}${f.flow60s.netSol.toFixed(2)}◎`, tone: f.flow60s.netSol >= 0 ? "ok" : "bad" },
              { label: "buyers", value: f.flow60s.buyers, tone: "ok" },
              { label: "sellers", value: f.flow60s.sellers, tone: "bad" },
              { label: "seller exhaustion", value: f.exhaustion === null ? "idle" : `${Math.round(f.exhaustion * 100)}%` },
            ]}
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
              <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                <Metric label="Dev holds" value={`${f.cohorts.dev.heldPct.toFixed(1)}%`} />
                <Metric label="Snipers hold" value={`${f.cohorts.snipers.heldPct.toFixed(1)}%`} />
                <Metric label="Bundles hold" value={`${f.cohorts.bundles.heldPct.toFixed(1)}%`} />
                <Metric label="Early buyers hold" value={`${f.cohorts.early.heldPct.toFixed(1)}%`} />
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
            tone={lastTrade && Date.now() - lastTrade.ts < 60_000 ? "live" : "idle"}
            badge={lastTrade && Date.now() - lastTrade.ts < 60_000 ? "Live" : "Quiet"}
            chips={
              lastTrade
                ? [
                    { label: `last ${lastTrade.side}`, value: `${lastTrade.sol.toFixed(3)}◎`, tone: lastTrade.side === "buy" ? "ok" : "bad" },
                    { value: ago(lastTrade.ts) },
                    { label: "shown", value: live.recentTrades.length },
                  ]
                : [{ value: "No trades read yet", tone: "idle" }]
            }
          >
            <div className="scroll-thin max-h-72 overflow-y-auto text-xs">
              {live.recentTrades.map((t) => (
                <div key={t.id} className="num grid grid-cols-[3rem_5rem_1fr_3rem] items-center gap-2 py-0.5">
                  <span className={t.side === "buy" ? "text-emerald-400" : "text-rose-400"}>{t.side}</span>
                  <span className="text-right text-zinc-200">{t.sol.toFixed(3)}◎</span>
                  <span className="text-zinc-500">
                    {t.wallet.slice(0, 4)}…{t.wallet.slice(-4)}
                  </span>
                  <span className="text-right text-zinc-600">{fmtAge(t.ts)}</span>
                </div>
              ))}
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}
