"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import Change from "./Change";
import OrdersTable from "./OrdersTable";
import PriceChart from "./PriceChart";
import TokenIcon from "./TokenIcon";
import TradePanel from "./TradePanel";
import { curveProgress, isBondingCurve, poolFor, quoteSell } from "@/lib/amm";
import { fmtAge, fmtCompact, fmtPct, fmtPrice, fmtSol, fmtTokens, pnlColor } from "@/lib/format";
import { useGraduated, usePairs, useSolPrice } from "@/lib/hooks";
import { ORDER_TAG, useWallet } from "@/lib/wallet";

export default function CoinView({ pairAddress }: { pairAddress: string }) {
  const solUsd = useSolPrice();
  const { pairs, error, updatedAt } = usePairs([pairAddress], 3_000);
  const { state } = useWallet();
  const pair = pairs[pairAddress];
  const pos = state.positions[pairAddress];
  const router = useRouter();

  // A completed pump.fun curve stops trading; follow the token to the pool it graduated to.
  const curveToken = pair && isBondingCurve(pair) ? [pair.tokenAddress] : [];
  const graduatedTo = useGraduated(curveToken)[curveToken[0] ?? ""];
  useEffect(() => {
    if (graduatedTo) router.replace(`/coin/${graduatedTo.pairAddress}`);
  }, [graduatedTo, router]);

  if (!pair)
    return (
      <div className="py-20 text-center text-zinc-500">
        {error || (updatedAt ? "Pair not found on Solana." : "Loading pair…")}
        <div className="mt-4">
          <Link href="/" className="text-sm text-zinc-400 underline">Back to discover</Link>
        </div>
      </div>
    );

  const pool = poolFor(pair, solUsd);
  const exitSol = pos && pool ? quoteSell(pool, pos.tokens).solOut : 0;
  const unrealized = pos ? exitSol - pos.costSol : 0;
  const rugged = pos && pos.liquidityUsdAtEntry > 0 && pair.liquidityUsd < pos.liquidityUsdAtEntry * 0.3;
  const myTrades = state.trades.filter((t) => t.pairAddress === pairAddress).slice(0, 15);

  const progress = curveProgress(pair);
  const stats = [
    ["Market cap", fmtCompact(pair.marketCap)],
    progress !== null ? ["Bonding curve", `${(progress * 100).toFixed(1)}%`] : ["Liquidity", fmtCompact(pair.liquidityUsd)],
    ["Vol 24h", fmtCompact(pair.volume24h)],
    ["Buys / sells 24h", `${pair.txns24h.buys.toLocaleString()} / ${pair.txns24h.sells.toLocaleString()}`],
    ["Pair age", fmtAge(pair.createdAt)],
    ["DEX", pair.dex],
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        <TokenIcon src={pair.imageUrl} symbol={pair.symbol} size={48} />
        <div>
          <h1 className="text-2xl font-bold text-white">
            {pair.symbol} <span className="text-base font-normal text-zinc-500">/ {pair.quoteSymbol}</span>
          </h1>
          <div className="text-sm text-zinc-500">{pair.name}</div>
        </div>
        <div className="ml-4">
          <div className="num text-2xl text-white">{fmtPrice(pair.priceUsd)}</div>
          <div className="flex gap-3 text-xs">
            <span>5m <Change v={pair.change.m5} /></span>
            <span>1h <Change v={pair.change.h1} /></span>
            <span>6h <Change v={pair.change.h6} /></span>
            <span>24h <Change v={pair.change.h24} /></span>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs text-zinc-500">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" /> Live
          </span>
          <a href={pair.url} target="_blank" rel="noreferrer" className="underline hover:text-white">DexScreener ↗</a>
          <button onClick={() => navigator.clipboard.writeText(pair.tokenAddress)} className="underline hover:text-white" title={pair.tokenAddress}>
            Copy CA
          </button>
        </div>
      </div>

      {rugged && (
        <div className="rounded-lg border border-rose-800 bg-rose-950/50 p-3 text-sm text-rose-300">
          ☢️ <b>Nuked?</b> Liquidity fell from {fmtCompact(pos.liquidityUsdAtEntry)} to {fmtCompact(pair.liquidityUsd)} since you bought. Exiting now costs heavy slippage.
        </div>
      )}
      {progress !== null && (
        <div className="rounded-lg border border-violet-900 bg-violet-950/40 p-3 text-sm text-violet-200">
          <div className="mb-2 flex justify-between">
            <span>
              🎓 On the pump.fun bonding curve — graduates to PumpSwap at 100%. Your position and orders move over automatically.
            </span>
            <span className="num ml-3 shrink-0">{(progress * 100).toFixed(1)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-violet-950">
            <div className="h-full rounded-full bg-violet-400 transition-all" style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
      )}
      {!rugged && progress === null && pair.liquidityUsd < 10_000 && (
        <div className="rounded-lg border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-300">
          ⚠️ Very thin liquidity ({fmtCompact(pair.liquidityUsd)}). Small trades will move the price a lot.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <PriceChart pairAddress={pairAddress} livePrice={pair.priceUsd} />
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-zinc-800 bg-zinc-800 sm:grid-cols-3 lg:grid-cols-6">
            {stats.map(([k, v]) => (
              <div key={k} className="bg-zinc-950 p-3">
                <div className="text-[11px] uppercase text-zinc-500">{k}</div>
                <div className="num text-sm text-white">{v}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-4">
          <TradePanel pair={pair} solUsd={solUsd} />

          {pos && (
            <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-sm">
              <div className="font-semibold text-white">Your position</div>
              <Row k="Holding" v={`${fmtTokens(pos.tokens)} ${pair.symbol}`} />
              <Row k="Cost basis" v={fmtSol(pos.costSol)} />
              <Row k="Exit value (after slippage)" v={fmtSol(exitSol)} />
              <Row
                k="Unrealized PnL"
                v={<span className={pnlColor(unrealized)}>{`${unrealized >= 0 ? "+" : ""}${unrealized.toFixed(3)} SOL (${fmtPct((unrealized / pos.costSol) * 100)})`}</span>}
              />
              {pos.realizedSol !== 0 && (
                <Row k="Realized" v={<span className={pnlColor(pos.realizedSol)}>{`${pos.realizedSol >= 0 ? "+" : ""}${pos.realizedSol.toFixed(3)} SOL`}</span>} />
              )}
            </div>
          )}

          {state.orders.some((o) => o.pairAddress === pairAddress) && (
            <div className="space-y-2">
              <div className="text-sm font-semibold text-white">Orders</div>
              <OrdersTable pairs={pairs} pairAddress={pairAddress} historyLimit={5} />
            </div>
          )}

          {myTrades.length > 0 && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-xs">
              <div className="mb-2 text-sm font-semibold text-white">Your trades</div>
              {myTrades.map((t) => (
                <div key={t.id} className="flex justify-between border-t border-zinc-900 py-1.5">
                  <span className={t.side === "buy" ? "text-emerald-400" : "text-rose-400"}>
                    {t.side.toUpperCase()}
                    {t.orderKind && <span className="ml-1 text-zinc-500">{ORDER_TAG[t.orderKind]}</span>}
                  </span>
                  <span className="num">{fmtSol(t.solAmount)}</span>
                  <span className="num text-zinc-500">@ {fmtPrice(t.priceUsd)}</span>
                  <span className="text-zinc-500">{new Date(t.ts).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between">
      <span className="text-zinc-500">{k}</span>
      <span className="num">{v}</span>
    </div>
  );
}
