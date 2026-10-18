"use client";

import Link from "next/link";
import TokenIcon from "./TokenIcon";
import { fmtPct, fmtPrice, fmtSol } from "@/lib/format";
import type { Pair } from "@/lib/types";
import { ORDER_LABEL, type Order, useWallet } from "@/lib/wallet";

const KIND_COLOR: Record<Order["kind"], string> = {
  limit_buy: "text-emerald-400",
  take_profit: "text-sky-400",
  stop_loss: "text-rose-400",
};

const STATUS_COLOR: Record<Order["status"], string> = {
  open: "text-zinc-300",
  filled: "text-emerald-400",
  cancelled: "text-zinc-500",
  failed: "text-rose-400",
};

const size = (o: Order) => (o.kind === "limit_buy" ? fmtSol(o.solAmount ?? 0) : `${Math.round((o.fraction ?? 1) * 100)}% of bag`);

/** Open orders (with live distance to trigger) plus recent closed ones. */
export default function OrdersTable({
  pairs,
  pairAddress,
  historyLimit = 10,
}: {
  pairs: Record<string, Pair>;
  /** Only show orders for this pair (and hide the token column). */
  pairAddress?: string;
  historyLimit?: number;
}) {
  const { state, cancelOrder } = useWallet();
  const mine = state.orders.filter((o) => !pairAddress || o.pairAddress === pairAddress);
  const open = mine.filter((o) => o.status === "open");
  const closed = mine
    .filter((o) => o.status !== "open")
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
    .slice(0, historyLimit);

  if (pairAddress && mine.length === 0) return null;

  const tokenCell = (o: Order) =>
    !pairAddress && (
      <td className="px-3 py-2">
        <Link href={`/coin/${o.pairAddress}`} className="flex items-center gap-2">
          <TokenIcon src={o.imageUrl} symbol={o.symbol} size={24} />
          <span className="font-semibold text-white">{o.symbol}</span>
        </Link>
      </td>
    );

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-xl border border-zinc-800">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="bg-zinc-900/60 text-xs uppercase text-zinc-500">
            <tr>
              {!pairAddress && <th className="px-3 py-2 text-left font-medium">Token</th>}
              <th className="px-3 py-2 text-left font-medium">Order</th>
              <th className="px-3 py-2 text-right font-medium">Trigger</th>
              <th className="px-3 py-2 text-right font-medium">Distance</th>
              <th className="px-3 py-2 text-right font-medium">Size</th>
              <th className="px-3 py-2 text-right font-medium" />
            </tr>
          </thead>
          <tbody>
            {open.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-zinc-500">
                  No open orders.
                </td>
              </tr>
            )}
            {open.map((o) => {
              const price = pairs[o.pairAddress]?.priceUsd;
              const dist = price ? (o.triggerPriceUsd / price - 1) * 100 : null;
              return (
                <tr key={o.id} className="border-t border-zinc-900">
                  {tokenCell(o)}
                  <td className={`px-3 py-2 font-semibold ${KIND_COLOR[o.kind]}`}>{ORDER_LABEL[o.kind]}</td>
                  <td className="num px-3 py-2 text-right">
                    {o.kind === "take_profit" ? "≥ " : "≤ "}
                    {fmtPrice(o.triggerPriceUsd)}
                  </td>
                  <td className="num px-3 py-2 text-right text-zinc-400">{dist === null ? "…" : fmtPct(dist)}</td>
                  <td className="num px-3 py-2 text-right">{size(o)}</td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => cancelOrder(o.id)} className="rounded-md bg-zinc-800 px-2.5 py-1 text-xs hover:bg-zinc-700">
                      Cancel
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {closed.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full min-w-[560px] text-xs">
            <tbody>
              {closed.map((o) => (
                <tr key={o.id} className="border-t border-zinc-900 first:border-t-0">
                  {tokenCell(o)}
                  <td className={`px-3 py-2 ${KIND_COLOR[o.kind]}`}>{ORDER_LABEL[o.kind]}</td>
                  <td className="num px-3 py-2 text-right text-zinc-400">{fmtPrice(o.triggerPriceUsd)}</td>
                  <td className="num px-3 py-2 text-right text-zinc-400">{size(o)}</td>
                  <td className={`px-3 py-2 capitalize ${STATUS_COLOR[o.status]}`}>{o.status}</td>
                  <td className="px-3 py-2 text-zinc-500">{o.note}</td>
                  <td className="px-3 py-2 text-right text-zinc-500">{o.closedAt ? new Date(o.closedAt).toLocaleTimeString() : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
