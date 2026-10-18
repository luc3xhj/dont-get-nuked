"use client";

import Link from "next/link";
import { useState } from "react";
import OrdersTable from "@/components/OrdersTable";
import TokenIcon from "@/components/TokenIcon";
import { poolFor, quoteSell } from "@/lib/amm";
import { fmtCompact, fmtPct, fmtPrice, fmtSol, fmtTokens, pnlColor } from "@/lib/format";
import { usePairs, useSolPrice } from "@/lib/hooks";
import { ORDER_TAG, STARTING_SOL, useWallet } from "@/lib/wallet";

const signed = (v: number, d = 3) => `${v >= 0 ? "+" : ""}${v.toFixed(d)} SOL`;

export default function Portfolio() {
  const { state, hydrated, sell, reset } = useWallet();
  const solUsd = useSolPrice();
  const positions = Object.values(state.positions);
  const openOrderPairs = state.orders.filter((o) => o.status === "open").map((o) => o.pairAddress);
  const { pairs } = usePairs([...positions.map((p) => p.pairAddress), ...openOrderPairs], 5_000);
  const [startSol, setStartSol] = useState(String(STARTING_SOL));

  const rows = positions.map((pos) => {
    const pair = pairs[pos.pairAddress];
    const pool = pair && poolFor(pair, solUsd);
    const exit = pool ? quoteSell(pool, pos.tokens).solOut : null;
    return { pos, pair, exit, pnl: exit === null ? null : exit - pos.costSol };
  });
  const holdings = rows.reduce((s, r) => s + (r.exit ?? r.pos.costSol), 0);
  const unrealized = rows.reduce((s, r) => s + (r.pnl ?? 0), 0);
  const equity = state.sol + holdings;
  const sells = state.trades.filter((t) => t.side === "sell");
  const wins = sells.filter((t) => (t.pnlSol ?? 0) > 0).length;

  if (!hydrated) return null;

  const cards: [string, React.ReactNode][] = [
    ["Net worth", <span key="nw">{fmtSol(equity)} <span className="text-sm text-zinc-500">{solUsd ? fmtCompact(equity * solUsd) : ""}</span></span>],
    ["Total return", <span key="tr" className={pnlColor(equity - state.startSol)}>{signed(equity - state.startSol)} ({fmtPct(((equity - state.startSol) / state.startSol) * 100)})</span>],
    ["Realized", <span key="re" className={pnlColor(state.realizedSol)}>{signed(state.realizedSol)}</span>],
    ["Unrealized", <span key="un" className={pnlColor(unrealized)}>{signed(unrealized)}</span>],
    ["Win rate", sells.length ? `${Math.round((wins / sells.length) * 100)}% (${wins}/${sells.length})` : "–"],
    ["Fees paid", fmtSol(state.feesSol)],
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-zinc-800 bg-zinc-800 md:grid-cols-3 lg:grid-cols-6">
        {cards.map(([k, v]) => (
          <div key={k} className="bg-zinc-950 p-4">
            <div className="text-[11px] uppercase text-zinc-500">{k}</div>
            <div className="num mt-1 text-white">{v}</div>
          </div>
        ))}
      </div>

      <section>
        <h2 className="mb-2 text-lg font-semibold text-white">Open positions</h2>
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-zinc-900/60 text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Token</th>
                <th className="px-3 py-2 text-right font-medium">Holding</th>
                <th className="px-3 py-2 text-right font-medium">Price</th>
                <th className="px-3 py-2 text-right font-medium">Cost</th>
                <th className="px-3 py-2 text-right font-medium">Exit value</th>
                <th className="px-3 py-2 text-right font-medium">PnL</th>
                <th className="px-3 py-2 text-right font-medium" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center text-zinc-500">
                    No open positions. <Link href="/" className="underline hover:text-white">Find a coin</Link> to ape into.
                  </td>
                </tr>
              )}
              {rows.map(({ pos, pair, exit, pnl }) => (
                <tr key={pos.pairAddress} className="border-t border-zinc-900">
                  <td className="px-3 py-2">
                    <Link href={`/coin/${pos.pairAddress}`} className="flex items-center gap-3">
                      <TokenIcon src={pos.imageUrl} symbol={pos.symbol} />
                      <div>
                        <div className="font-semibold text-white">{pos.symbol}</div>
                        <div className="text-xs text-zinc-500">{pos.name}</div>
                      </div>
                    </Link>
                  </td>
                  <td className="num px-3 py-2 text-right">{fmtTokens(pos.tokens)}</td>
                  <td className="num px-3 py-2 text-right">{pair ? fmtPrice(pair.priceUsd) : "…"}</td>
                  <td className="num px-3 py-2 text-right">{fmtSol(pos.costSol)}</td>
                  <td className="num px-3 py-2 text-right">{exit === null ? "…" : fmtSol(exit)}</td>
                  <td className={`num px-3 py-2 text-right ${pnlColor(pnl ?? 0)}`}>
                    {pnl === null ? "…" : `${signed(pnl)} (${fmtPct((pnl / pos.costSol) * 100)})`}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      disabled={!pair || !solUsd}
                      onClick={() => pair && sell(pair, solUsd, 1)}
                      className="rounded-md bg-rose-500/15 px-3 py-1 text-xs font-semibold text-rose-400 hover:bg-rose-500/25 disabled:opacity-40"
                    >
                      Sell all
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold text-white">Orders</h2>
        <OrdersTable pairs={pairs} />
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold text-white">Trade history</h2>
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-zinc-900/60 text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Time</th>
                <th className="px-3 py-2 text-left font-medium">Side</th>
                <th className="px-3 py-2 text-left font-medium">Token</th>
                <th className="px-3 py-2 text-right font-medium">SOL</th>
                <th className="px-3 py-2 text-right font-medium">Tokens</th>
                <th className="px-3 py-2 text-right font-medium">Avg price</th>
                <th className="px-3 py-2 text-right font-medium">Impact</th>
                <th className="px-3 py-2 text-right font-medium">PnL</th>
              </tr>
            </thead>
            <tbody>
              {state.trades.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-zinc-500">No trades yet.</td>
                </tr>
              )}
              {state.trades.map((t) => (
                <tr key={t.id} className="border-t border-zinc-900">
                  <td className="px-3 py-2 text-zinc-400">{new Date(t.ts).toLocaleString()}</td>
                  <td className={`px-3 py-2 font-semibold ${t.side === "buy" ? "text-emerald-400" : "text-rose-400"}`}>{t.side.toUpperCase()}
                    {t.orderKind && <span className="ml-1 text-xs font-normal text-zinc-500">{ORDER_TAG[t.orderKind]}</span>}
                  </td>
                  <td className="px-3 py-2">
                    <Link href={`/coin/${t.pairAddress}`} className="hover:underline">{t.symbol}</Link>
                  </td>
                  <td className="num px-3 py-2 text-right">{t.solAmount.toFixed(4)}</td>
                  <td className="num px-3 py-2 text-right">{fmtTokens(t.tokenAmount)}</td>
                  <td className="num px-3 py-2 text-right">{fmtPrice(t.priceUsd)}</td>
                  <td className="num px-3 py-2 text-right text-zinc-400">{fmtPct(-t.priceImpact * 100, 2)}</td>
                  <td className={`num px-3 py-2 text-right ${pnlColor(t.pnlSol ?? 0)}`}>{t.pnlSol === undefined ? "" : signed(t.pnlSol)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-800 p-4">
        <div className="text-sm">
          <div className="font-semibold text-white">Reset wallet</div>
          <div className="text-zinc-500">Wipes positions and history and starts over.</div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <input
            value={startSol}
            onChange={(e) => setStartSol(e.target.value.replace(/[^0-9.]/g, ""))}
            className="num w-24 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm outline-none"
          />
          <span className="text-sm text-zinc-500">SOL</span>
          <button
            onClick={() => {
              const n = Number(startSol);
              if (n > 0 && confirm(`Reset wallet to ${n} SOL? This clears all positions and history.`)) reset(n);
            }}
            className="rounded-lg bg-zinc-800 px-4 py-2 text-sm font-semibold hover:bg-zinc-700"
          >
            Reset
          </button>
        </div>
      </section>
    </div>
  );
}
