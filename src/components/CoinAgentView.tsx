"use client";

import Link from "next/link";
import ActivityFeed from "./ActivityFeed";
import { CopyIcon, GlobeIcon, TelegramIcon, XIcon } from "./Icons";
import PriceChart from "./PriceChart";
import TokenIcon from "./TokenIcon";
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
  type PortfolioReport,
} from "@/lib/agent";
import { fmtAge, fmtCompact, fmtPrice, pnlColor } from "@/lib/format";
import { usePolling } from "@/lib/hooks";

const Panel = ({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) => (
  <section className={`rounded-xl border border-zinc-800 bg-zinc-950 ${className}`}>
    <div className="border-b border-zinc-800 px-4 py-2 text-[11px] uppercase tracking-wide text-zinc-500">{title}</div>
    {children}
  </section>
);

function FlowBox({ label, f }: { label: string; f: Flow }) {
  const total = f.buySol + f.sellSol;
  return (
    <div className="space-y-0.5 bg-zinc-950 p-3 text-xs">
      <div className="text-[11px] uppercase text-zinc-500">{label}</div>
      <div className={`num text-sm ${f.netSol > 0 ? "text-emerald-400" : f.netSol < 0 ? "text-rose-400" : "text-zinc-400"}`}>
        {f.netSol > 0 ? "+" : ""}
        {f.netSol.toFixed(2)}◎ net
      </div>
      <div className="num text-zinc-500">
        {f.buyers} buyers / {f.sellers} sellers · {total ? Math.round((f.buySol / total) * 100) : 0}% buys
      </div>
      <div className="num text-zinc-500">
        new {(f.newBuyerShare * 100).toFixed(0)}% · median {f.medianBuySol.toFixed(2)}◎ · round-trip {(f.roundTripShare * 100).toFixed(0)}%
      </div>
    </div>
  );
}

export default function CoinAgentView({ mint }: { mint: string }) {
  const { data: d, error } = usePolling<CoinDetail>(`/api/agent/coin/${mint}`, 2_000);
  const { data: p } = usePolling<PortfolioReport>("/api/agent/portfolio", 4_000);

  if (!d)
    return (
      <div className="py-20 text-center text-zinc-500">
        {error ?? "Loading…"}
        <div className="mt-4">
          <Link href="/market" className="text-sm text-zinc-400 underline">
            Back to market
          </Link>
        </div>
      </div>
    );

  const position = p?.open.find((x) => x.account === "agent" && x.mint === mint);
  const closed = p?.closed.filter((x) => x.account === "agent" && x.mint === mint) ?? [];
  const realized = closed.reduce((s, c) => s + c.pnlSol, 0);
  const markers = d.fills.map((f) => ({ ts: f.ts, side: f.side }));
  const symbol = d.symbol ?? `${mint.slice(0, 4)}…`;
  const live = d.tracked ? d : null;
  const f = live?.features ?? null;
  const priceUsd = live?.quote?.priceUsd ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        <TokenIcon src={coinImage(mint)} symbol={symbol} size={52} />
        <div>
          <h1 className="text-2xl font-bold text-white">{symbol}</h1>
          <div className="text-sm text-zinc-500">
            {d.name}
            {live && (
              <>
                {" · "}
                {live.lane ? <span className={LANE_TONE[live.lane]}>{LANE_LABEL[live.lane]}</span> : live.stage}
                {live.stage === "curve" && ` ${Math.round((live.curveProgress ?? 0) * 100)}%`} · {fmtAge(live.createdAt)} old
              </>
            )}
          </div>
        </div>
        {live?.quote && (
          <div className="ml-2">
            <div className="num text-xl text-white">{fmtPrice(live.quote.priceUsd)}</div>
            <div className="num text-xs text-zinc-500">
              mcap {fmtCompact(live.quote.mcapUsd)}
              {live.quote.liquidityUsd > 0 && ` · liq ${fmtCompact(live.quote.liquidityUsd)}`}
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
          <a href={`https://pump.fun/coin/${mint}`} target="_blank" rel="noreferrer noopener" className="text-xs underline hover:text-white">
            pump.fun ↗
          </a>
          <button onClick={() => navigator.clipboard.writeText(mint)} className="hover:text-white" title="Copy contract address">
            <CopyIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      {!d.tracked && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-sm text-zinc-400">
          The agent isn&apos;t watching this coin right now, so live evidence isn&apos;t available. Its past trades on it are below.
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          {d.pairAddress && <PriceChart pairAddress={d.pairAddress} livePrice={priceUsd} markers={markers} />}

          <Panel title="The agent on this coin">
            <div className="grid grid-cols-2 gap-px bg-zinc-800 sm:grid-cols-4">
              <div className="bg-zinc-950 p-3">
                <div className="text-[11px] uppercase text-zinc-500">Position</div>
                <div className="num text-white">{position ? `${position.costSol.toFixed(3)}◎ in` : "None"}</div>
                {position && <div className="text-xs text-zinc-500">{SETUP_LABEL[position.setup] ?? position.setup}</div>}
              </div>
              <div className="bg-zinc-950 p-3">
                <div className="text-[11px] uppercase text-zinc-500">Open P&amp;L</div>
                <div className={`num ${pnlColor(position?.unrealizedSol ?? 0)}`}>
                  {position?.unrealizedSol != null ? solSigned(position.unrealizedSol) : "–"}
                </div>
              </div>
              <div className="bg-zinc-950 p-3">
                <div className="text-[11px] uppercase text-zinc-500">Closed trades</div>
                <div className="num text-white">{closed.length}</div>
              </div>
              <div className="bg-zinc-950 p-3">
                <div className="text-[11px] uppercase text-zinc-500">Realized</div>
                <div className={`num ${pnlColor(realized)}`}>{closed.length ? solSigned(realized) : "–"}</div>
              </div>
            </div>
            {d.fills.length > 0 && (
              <div className="divide-y divide-zinc-900 text-xs">
                {[...d.fills].reverse().map((x, i) => (
                  <div key={`${x.ts}-${i}`} className="num flex gap-4 px-4 py-1.5">
                    <span className={x.side === "buy" ? "text-emerald-400" : "text-rose-400"}>{x.side.toUpperCase()}</span>
                    <span className="text-zinc-300">{x.sol.toFixed(3)}◎</span>
                    <span className="text-zinc-500">{x.reason ?? ""}</span>
                    <span className="ml-auto text-zinc-600">{new Date(x.ts).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {f && (
            <div className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-zinc-800 bg-zinc-800 sm:grid-cols-3">
              <FlowBox label="Last 15s" f={f.flow15s} />
              <FlowBox label="Last 60s" f={f.flow60s} />
              <FlowBox label="Last 5m" f={f.flow5m} />
            </div>
          )}

          <Panel title="Agent activity on this coin">
            <div className="max-h-80 overflow-y-auto">
              <ActivityFeed mint={mint} limit={40} />
            </div>
          </Panel>
        </div>

        <aside className="space-y-4">
          {live?.analysis && (
            <section className={`rounded-xl border p-4 text-xs ${VERDICT_TONE[live.analysis.verdict]}`}>
              <div className="mb-1 flex justify-between font-semibold">
                <span>
                  Analyst: {live.analysis.verdict} · {live.analysis.narrativeType} · ×{live.analysis.conviction.toFixed(2)}
                </span>
                <span className="font-normal opacity-70">
                  {live.analysis.expiresAt < Date.now() ? "expired" : `valid ${Math.round((live.analysis.expiresAt - Date.now()) / 60_000)}m`}
                </span>
              </div>
              <div className="text-zinc-200">{live.analysis.narrative}</div>
              <div className="mt-1 text-zinc-400">{live.analysis.thesis}</div>
              <div className="mt-1 text-zinc-500">
                Contract verified: {live.analysis.contractVerified}
                {live.analysis.copycat && " · copycat"}
              </div>
              {live.analysis.greenFlags.map((g) => (
                <div key={g} className="text-emerald-300">
                  + {g}
                </div>
              ))}
              {live.analysis.redFlags.map((r) => (
                <div key={r} className="text-rose-300">
                  − {r}
                </div>
              ))}
              <div className="mt-1 text-zinc-500">Would change its mind: {live.analysis.wouldChangeMind}</div>
              {live.analysis.sources.map((u) => (
                <a key={u} href={u} target="_blank" rel="noreferrer noopener" className="block truncate text-zinc-400 underline">
                  {u}
                </a>
              ))}
            </section>
          )}

          {live && live.setups.length > 0 && (
            <Panel title="Setups">
              <div className="space-y-3 p-3">
                {live.setups.map((x) => (
                  <div key={x.setup} className="text-xs">
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
              </div>
            </Panel>
          )}

          {live && (
            <Panel title="Screens">
              <div className="space-y-1.5 p-3">
                {live.screens.map((x) => (
                  <div key={x.id} className="flex items-start gap-2 text-xs">
                    <span className={`shrink-0 rounded border px-1.5 py-0.5 ${SCREEN_TONE[x.level]}`}>{x.level}</span>
                    <span className="text-zinc-300">
                      <b className="font-medium text-white">{x.label}:</b> {x.detail}
                    </span>
                  </div>
                ))}
              </div>
              {live.social?.text && (
                <blockquote className="mx-3 mb-3 border-l-2 border-zinc-700 pl-3 text-xs text-zinc-400">
                  {live.social.text.slice(0, 280)}
                  <div className="mt-1 text-zinc-600">
                    @{live.social.author} · {live.social.authorFollowers?.toLocaleString()} followers
                    {live.social.likes != null && ` · ${live.social.likes} likes`}
                  </div>
                </blockquote>
              )}
            </Panel>
          )}

          {live?.holdersReport && (
            <Panel title={`Top holders · ${live.holdersReport.totalHolders?.toLocaleString() ?? "?"} total`}>
              <div className="p-3 text-xs">
                {live.holdersReport.top.slice(0, 10).map((h) => (
                  <div key={h.owner} className="num flex justify-between py-0.5">
                    <span className="text-zinc-400">
                      {h.owner.slice(0, 4)}…{h.owner.slice(-4)} {h.insider && <span className="text-rose-400">insider</span>}
                    </span>
                    <span className="text-zinc-300">{h.pct.toFixed(2)}%</span>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {live && (
            <Panel title="Live tape">
              <div className="max-h-80 overflow-y-auto p-3 text-xs">
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
            </Panel>
          )}
        </aside>
      </div>
    </div>
  );
}
