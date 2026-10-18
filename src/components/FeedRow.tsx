"use client";

import Link from "next/link";
import { BoltIcon, ChatIcon, CopyIcon, GlobeIcon, SearchIcon, TelegramIcon, XIcon } from "./Icons";
import TokenIcon from "./TokenIcon";
import { fmtAge, fmtCompact, fmtPct, pnlColor } from "@/lib/format";
import type { FeedItem, Window } from "@/lib/types";

export const ROW_GRID =
  "grid grid-cols-[minmax(250px,2.4fr)_minmax(96px,1fr)_minmax(96px,1fr)_minmax(84px,0.9fr)_minmax(120px,1.1fr)_minmax(170px,1.5fr)_96px] items-center gap-3";

function SocialLink({ href, label, children }: { href: string | null; label: string; children: React.ReactNode }) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      title={label}
      onClick={(e) => e.stopPropagation()}
      className="text-zinc-500 transition-colors hover:text-white"
    >
      {children}
    </a>
  );
}

function Chip({ tone, title, children }: { tone: "violet" | "emerald" | "rose" | "amber" | "sky" | "zinc"; title?: string; children: React.ReactNode }) {
  const tones = {
    violet: "bg-violet-500/10 text-violet-300",
    emerald: "bg-emerald-500/10 text-emerald-300",
    rose: "bg-rose-500/10 text-rose-300",
    amber: "bg-amber-500/10 text-amber-300",
    sky: "bg-sky-500/10 text-sky-300",
    zinc: "bg-zinc-800 text-zinc-400",
  };
  return (
    <span title={title} className={`num inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${tones[tone]}`}>
      {children}
    </span>
  );
}

export default function FeedRow({
  item,
  window: w,
  quickBuySol,
  onQuickBuy,
  holding,
}: {
  item: FeedItem;
  window: Window;
  quickBuySol: number;
  onQuickBuy: (item: FeedItem) => void;
  holding: boolean;
}) {
  const { pair, socials } = item;
  const s = item.windows[w];
  const txns = s.buys + s.sells;
  const buyShare = txns ? s.buys / txns : 0;
  const ageMs = item.createdAt ? Date.now() - item.createdAt : Infinity;
  const fromAth = item.athMarketCapUsd && item.athMarketCapUsd > 0 ? (pair.marketCap / item.athMarketCapUsd - 1) * 100 : null;
  const progress = item.curveProgress;
  const xSearch = `https://x.com/search?q=${encodeURIComponent(pair.tokenAddress)}&f=live`;

  return (
    <div className={`${ROW_GRID} group relative border-t border-zinc-900 px-4 py-3 transition-colors hover:bg-zinc-900/50`}>
      <Link href={`/coin/${pair.pairAddress}`} className="absolute inset-0" aria-label={`Open ${pair.symbol}`} />

      {/* Pair info */}
      <div className="pointer-events-none relative flex min-w-0 items-center gap-3">
        <div className="relative shrink-0">
          <TokenIcon src={pair.imageUrl} symbol={pair.symbol} size={48} />
          {progress !== null && (
            <div className="absolute -bottom-1 left-1 right-1 h-1 overflow-hidden rounded-full bg-zinc-800" title={`Bonding curve ${(progress * 100).toFixed(0)}%`}>
              <div className="h-full bg-violet-400" style={{ width: `${progress * 100}%` }} />
            </div>
          )}
          {item.live && <span className="absolute -right-1 -top-1 rounded bg-rose-500 px-1 text-[9px] font-bold text-white">LIVE</span>}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-semibold text-white">{pair.symbol}</span>
            <span className="truncate text-sm text-zinc-500">{pair.name}</span>
            {holding && <Chip tone="emerald">HOLD</Chip>}
          </div>
          <div className="pointer-events-auto mt-1 flex items-center gap-2 text-xs">
            <span className={`num ${ageMs < 10 * 60_000 ? "text-emerald-400" : "text-zinc-400"}`}>{fmtAge(item.createdAt)}</span>
            <SocialLink href={socials.twitter} label="X / Twitter">
              <XIcon />
            </SocialLink>
            <SocialLink href={socials.telegram} label="Telegram">
              <TelegramIcon />
            </SocialLink>
            <SocialLink href={socials.website} label="Website">
              <GlobeIcon />
            </SocialLink>
            <SocialLink href={xSearch} label="Search the contract address on X">
              <SearchIcon />
            </SocialLink>
            <button
              onClick={() => navigator.clipboard.writeText(pair.tokenAddress)}
              title="Copy contract address"
              className="text-zinc-500 transition-colors hover:text-white"
            >
              <CopyIcon />
            </button>
            {item.replies !== null && item.replies > 0 && (
              <span className="num flex items-center gap-1 text-zinc-500" title="pump.fun replies">
                <ChatIcon className="h-3 w-3" />
                {item.replies}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Market cap */}
      <div className="pointer-events-none relative">
        <div className="num text-white">{fmtCompact(pair.marketCap)}</div>
        <div className={`num text-xs ${pnlColor(s.change)}`}>{txns || s.change ? fmtPct(s.change) : "–"}</div>
      </div>

      {/* Liquidity or curve */}
      <div className="pointer-events-none relative">
        {progress !== null ? (
          <>
            <div className="num text-violet-300">{(progress * 100).toFixed(0)}%</div>
            <div className="text-xs text-zinc-500">bonding</div>
          </>
        ) : (
          <>
            <div className={`num ${pair.liquidityUsd < 10_000 ? "text-amber-400" : "text-white"}`}>{fmtCompact(pair.liquidityUsd)}</div>
            <div className="text-xs text-zinc-500">{pair.dex}</div>
          </>
        )}
      </div>

      {/* Volume */}
      <div className="num pointer-events-none relative text-white">{s.volume ? fmtCompact(s.volume) : "–"}</div>

      {/* Txns + buy pressure */}
      <div className="pointer-events-none relative">
        <div className="num text-white">{txns ? txns.toLocaleString() : "–"}</div>
        {txns > 0 && (
          <>
            <div className="num text-xs">
              <span className="text-emerald-400">{s.buys}</span>
              <span className="text-zinc-600"> / </span>
              <span className="text-rose-400">{s.sells}</span>
            </div>
            <div className="mt-1 flex h-1 w-20 overflow-hidden rounded-full bg-rose-500/60">
              <div className="h-full bg-emerald-400" style={{ width: `${buyShare * 100}%` }} />
            </div>
          </>
        )}
      </div>

      {/* Token info */}
      <div className="pointer-events-none relative flex flex-wrap gap-1">
        {fromAth !== null && (
          <Chip tone={fromAth > -20 ? "emerald" : fromAth > -60 ? "amber" : "rose"} title={`ATH market cap ${fmtCompact(item.athMarketCapUsd!)}`}>
            ATH {fromAth > -1 ? "now" : `${fromAth.toFixed(0)}%`}
          </Chip>
        )}
        {progress === null && item.replies !== null && <Chip tone="sky">Graduated</Chip>}
        <Chip tone={item.dexPaid ? "emerald" : "zinc"} title="Paid DexScreener profile">
          {item.dexPaid ? "Dex paid" : "Unpaid"}
        </Chip>
        {item.boosts > 0 && <Chip tone="amber">⚡{item.boosts}</Chip>}
        {!socials.twitter && !socials.telegram && !socials.website && <Chip tone="rose">No socials</Chip>}
      </div>

      {/* Quick buy */}
      <div className="relative flex justify-end">
        <button
          onClick={() => onQuickBuy(item)}
          className="num flex items-center gap-1 rounded-md bg-emerald-500/15 px-2.5 py-1.5 text-xs font-semibold text-emerald-300 transition-colors hover:bg-emerald-500 hover:text-black"
          title={`Buy ${quickBuySol} SOL of ${pair.symbol}`}
        >
          <BoltIcon className="h-3 w-3" />
          {quickBuySol}
        </button>
      </div>
    </div>
  );
}
