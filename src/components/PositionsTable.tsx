"use client";

import Link from "next/link";
import TokenIcon from "./TokenIcon";
import { coinImage, pctSigned, SETUP_LABEL, solSigned, type ClosedTrade, type OpenPosition } from "@/lib/agent";
import { fmtAge, pnlColor } from "@/lib/format";

export function OpenPositions({ positions }: { positions: OpenPosition[] }) {
  if (!positions.length)
    return (
      <div className="px-4 py-8 text-center text-sm text-zinc-500">
        No open positions. The agent buys only when a setup fires and passes its checks.
      </div>
    );
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-sm">
        <thead className="text-[11px] uppercase tracking-wide text-zinc-500">
          <tr className="text-left">
            <th className="px-4 py-2 font-medium">Coin</th>
            <th className="px-3 py-2 font-medium">Size</th>
            <th className="px-3 py-2 font-medium">Move</th>
            <th className="px-3 py-2 font-medium">P&amp;L</th>
            <th className="px-3 py-2 font-medium">Plan</th>
            <th className="px-3 py-2 font-medium">Held</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const move = p.priceSol ? p.priceSol / p.entryPriceSol - 1 : null;
            return (
              <tr key={p.id} className="border-t border-zinc-900" title={p.evidence.join("\n")}>
                <td className="px-4 py-2">
                  <Link href={`/coin/${p.mint}`} className="flex items-center gap-2.5 hover:underline">
                    <TokenIcon src={coinImage(p.mint)} symbol={p.symbol} size={28} />
                    <div>
                      <div className="font-semibold text-white">{p.symbol}</div>
                      <div className="text-xs text-zinc-500">{SETUP_LABEL[p.setup] ?? p.setup}</div>
                    </div>
                  </Link>
                </td>
                <td className="num px-3 py-2 text-zinc-300">{p.costSol.toFixed(3)}◎</td>
                <td className={`num px-3 py-2 ${pnlColor(move ?? 0)}`}>{move === null ? "…" : pctSigned(move, 1)}</td>
                <td className={`num px-3 py-2 ${pnlColor(p.unrealizedSol ?? 0)}`}>{p.unrealizedSol === null ? "…" : solSigned(p.unrealizedSol)}</td>
                <td className="num px-3 py-2 text-xs text-zinc-400">
                  <div>
                    stop {pctSigned(p.stopSol / p.entryPriceSol - 1)}
                    {p.tp1Done && <span className="ml-1 text-emerald-400">trailing</span>}
                  </div>
                  <div>
                    targets {pctSigned(p.plan.tp1Sol / p.entryPriceSol - 1)} / {pctSigned(p.plan.tp2Sol / p.entryPriceSol - 1)}
                  </div>
                </td>
                <td className="num px-3 py-2 text-xs text-zinc-500">
                  {p.heldMin.toFixed(1)}m / {p.plan.maxHoldMin}m
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ClosedTrades({ trades, showAccount = false }: { trades: ClosedTrade[]; showAccount?: boolean }) {
  if (!trades.length) return <div className="px-4 py-8 text-center text-sm text-zinc-500">No closed trades yet.</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-xs">
        <tbody>
          {trades.map((c) => (
            <tr key={c.id} className="border-t border-zinc-900 first:border-t-0">
              <td className="px-4 py-2 text-zinc-500">{fmtAge(c.closedAt)} ago</td>
              {showAccount && <td className="px-3 py-2 capitalize text-zinc-400">{c.account}</td>}
              <td className="px-3 py-2">
                <Link href={`/coin/${c.mint}`} className="font-semibold text-white hover:underline">
                  {c.symbol}
                </Link>
              </td>
              <td className="px-3 py-2 text-zinc-500">{SETUP_LABEL[c.setup] ?? c.setup}</td>
              <td className={`num px-3 py-2 ${pnlColor(c.pnlSol)}`}>{solSigned(c.pnlSol)}</td>
              <td className={`num px-3 py-2 ${pnlColor(c.pnlPct)}`}>{pctSigned(c.pnlPct, 1)}</td>
              <td className={`num px-3 py-2 ${pnlColor(c.r)}`}>{c.r.toFixed(2)}R</td>
              <td className="num px-3 py-2 text-zinc-500">{c.holdMin.toFixed(1)}m</td>
              <td className="px-3 py-2 text-zinc-400">{c.exitReason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
