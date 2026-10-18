"use client";

import { useState } from "react";
import { isBondingCurve, NETWORK_FEE_SOL, poolFor, quoteBuy, quoteSell } from "@/lib/amm";
import { fmtCompact, fmtPct, fmtPrice, fmtSol, fmtTokens } from "@/lib/format";
import type { Pair } from "@/lib/types";
import { type NewOrder, useWallet } from "@/lib/wallet";

const BUY_PRESETS = [0.1, 0.25, 0.5, 1, 2];
const SELL_PRESETS = [0.25, 0.5, 1];
const DIP_PRESETS = [-10, -25, -50];
const TP_PRESETS = [25, 50, 100, 200];
const SL_PRESETS = [-10, -25, -50];

function impactClass(impact: number) {
  if (impact > 0.15) return "text-rose-400";
  if (impact > 0.05) return "text-amber-400";
  return "text-zinc-300";
}

const parsePct = (v: string) => (v.trim() === "" || v.trim() === "-" ? null : Number(v));

export default function TradePanel({ pair, solUsd }: { pair: Pair; solUsd: number }) {
  const { state, buy, sell, placeOrders } = useWallet();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [mode, setMode] = useState<"market" | "trigger">("market");
  const [amount, setAmount] = useState("0.25");
  const [fraction, setFraction] = useState(1);
  const [dipPct, setDipPct] = useState("-25");
  const [tpPct, setTpPct] = useState("100");
  const [slPct, setSlPct] = useState("-25");
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);

  const pool = poolFor(pair, solUsd);
  const pos = state.positions[pair.pairAddress];
  const solIn = Number(amount);
  const quote =
    mode !== "market" || !pool
      ? null
      : side === "buy"
        ? solIn > 0
          ? quoteBuy(pool, solIn)
          : null
        : pos
          ? quoteSell(pool, pos.tokens * fraction)
          : null;

  const dip = parsePct(dipPct);
  const tp = parsePct(tpPct);
  const sl = parsePct(slPct);
  const priceAt = (pct: number) => pair.priceUsd * (1 + pct / 100);

  let triggerError: string | null = null;
  if (mode === "trigger") {
    if (side === "buy") {
      if (!(solIn > 0)) triggerError = "Enter an amount";
      else if (dip === null || !(dip < 0 && dip > -100)) triggerError = "Limit buy needs a % below the current price";
    } else {
      if (!pos) triggerError = "You don't hold this token";
      else if (tp === null && sl === null) triggerError = "Set a take profit, a stop loss, or both";
      else if (tp !== null && !(tp > 0)) triggerError = "Take profit must be above the current price";
      else if (sl !== null && !(sl < 0 && sl > -100)) triggerError = "Stop loss must be between 0% and -100%";
    }
  }

  const submitMarket = () => {
    const res = side === "buy" ? buy(pair, solUsd, solIn) : sell(pair, solUsd, fraction);
    if (!res.ok) return setFlash({ ok: false, text: res.error });
    const t = res.trade;
    setFlash({
      ok: true,
      text:
        t.side === "buy"
          ? `Bought ${fmtTokens(t.tokenAmount)} ${t.symbol} for ${fmtSol(t.solAmount)}`
          : `Sold ${fmtTokens(t.tokenAmount)} ${t.symbol} for ${fmtSol(t.solAmount)} (${t.pnlSol! >= 0 ? "+" : ""}${t.pnlSol!.toFixed(3)} SOL)`,
    });
  };

  const submitTrigger = () => {
    if (triggerError) return setFlash({ ok: false, text: triggerError });
    const base = {
      pairAddress: pair.pairAddress,
      tokenAddress: pair.tokenAddress,
      curve: isBondingCurve(pair),
      symbol: pair.symbol,
      imageUrl: pair.imageUrl,
      refPriceUsd: pair.priceUsd,
    };
    const orders: NewOrder[] = [];
    if (side === "buy") orders.push({ ...base, kind: "limit_buy", triggerPriceUsd: priceAt(dip!), solAmount: solIn });
    else {
      if (tp !== null) orders.push({ ...base, kind: "take_profit", triggerPriceUsd: priceAt(tp), fraction });
      if (sl !== null) orders.push({ ...base, kind: "stop_loss", triggerPriceUsd: priceAt(sl), fraction });
    }
    placeOrders(orders);
    setFlash({ ok: true, text: `Placed ${orders.length === 1 ? "order" : `${orders.length} orders`}. It fills automatically while the app is open.` });
  };

  const amountInput = (
    <div className="space-y-2">
      <div className="flex justify-between text-xs text-zinc-500">
        <span>Amount</span>
        <button className="hover:text-white" onClick={() => setAmount(Math.max(0, state.sol - NETWORK_FEE_SOL).toFixed(4))}>
          Balance: <span className="num">{fmtSol(state.sol)}</span>
        </button>
      </div>
      <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-900 focus-within:border-zinc-600">
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          inputMode="decimal"
          className="num w-full bg-transparent px-3 py-2.5 text-lg outline-none"
        />
        <span className="pr-3 text-sm text-zinc-500">SOL</span>
      </div>
      <div className="flex gap-1.5">
        {BUY_PRESETS.map((p) => (
          <button
            key={p}
            onClick={() => setAmount(String(p))}
            className={`num flex-1 rounded-md border py-1.5 text-xs ${solIn === p ? "border-emerald-500 text-emerald-400" : "border-zinc-800 text-zinc-400 hover:text-white"}`}
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );

  const fractionInput = (
    <div className="space-y-2">
      <div className="flex justify-between text-xs text-zinc-500">
        <span>Sell</span>
        <span>
          Holding: <span className="num">{pos ? fmtTokens(pos.tokens) : 0} {pair.symbol}</span>
        </span>
      </div>
      <div className="flex gap-1.5">
        {SELL_PRESETS.map((f) => (
          <button
            key={f}
            onClick={() => setFraction(f)}
            className={`flex-1 rounded-md border py-2 text-sm ${fraction === f ? "border-rose-500 text-rose-400" : "border-zinc-800 text-zinc-400 hover:text-white"}`}
          >
            {f === 1 ? "100%" : `${f * 100}%`}
          </button>
        ))}
      </div>
    </div>
  );

  const pctInput = (label: string, value: string, set: (v: string) => void, presets: number[], tone: "up" | "down", optional: boolean) => {
    const pct = parsePct(value);
    const active = tone === "up" ? "border-emerald-500 text-emerald-400" : "border-rose-500 text-rose-400";
    return (
      <div className="space-y-2">
        <div className="flex justify-between text-xs text-zinc-500">
          <span>{label}</span>
          {optional && pct !== null && (
            <button onClick={() => set("")} className="hover:text-white">
              Clear
            </button>
          )}
        </div>
        <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-900 focus-within:border-zinc-600">
          <input
            value={value}
            onChange={(e) => set(e.target.value.replace(/[^0-9.-]/g, ""))}
            placeholder={optional ? "Off" : ""}
            inputMode="decimal"
            className="num w-full bg-transparent px-3 py-2 outline-none placeholder:text-zinc-600"
          />
          <span className="pr-3 text-sm text-zinc-500">%</span>
        </div>
        <div className="flex gap-1.5">
          {presets.map((p) => (
            <button
              key={p}
              onClick={() => set(String(p))}
              className={`num flex-1 rounded-md border py-1 text-xs ${pct === p ? active : "border-zinc-800 text-zinc-400 hover:text-white"}`}
            >
              {p > 0 ? `+${p}` : p}%
            </button>
          ))}
        </div>
        {pct !== null && Number.isFinite(pct) && pct > -100 && (
          <div className="text-xs text-zinc-500">
            Triggers at <span className="num text-zinc-300">{fmtPrice(priceAt(pct))}</span>
            {pair.marketCap > 0 && (
              <>
                {" "}· MCap <span className="num text-zinc-300">{fmtCompact(pair.marketCap * (1 + pct / 100))}</span>
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
      <div className="grid grid-cols-2 rounded-lg bg-zinc-900 p-1">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            onClick={() => {
              setSide(s);
              setFlash(null);
            }}
            className={`rounded-md py-2 text-sm font-semibold capitalize ${
              side === s ? (s === "buy" ? "bg-emerald-500 text-black" : "bg-rose-500 text-black") : "text-zinc-400"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="flex gap-4 border-b border-zinc-800 text-sm">
        {(["market", "trigger"] as const).map((m) => (
          <button
            key={m}
            onClick={() => {
              setMode(m);
              setFlash(null);
            }}
            className={`-mb-px border-b-2 pb-2 ${mode === m ? "border-white text-white" : "border-transparent text-zinc-500 hover:text-white"}`}
          >
            {m === "market" ? "Market" : side === "buy" ? "Limit" : "TP / SL"}
          </button>
        ))}
      </div>

      {side === "buy" ? amountInput : fractionInput}

      {mode === "trigger" && side === "buy" && pctInput("Buy when price drops by", dipPct, setDipPct, DIP_PRESETS, "down", false)}
      {mode === "trigger" && side === "sell" && (
        <>
          {pctInput("Take profit", tpPct, setTpPct, TP_PRESETS, "up", true)}
          {pctInput("Stop loss", slPct, setSlPct, SL_PRESETS, "down", true)}
          <p className="text-xs text-zinc-500">
            Sells {fraction === 1 ? "your whole bag" : `${fraction * 100}% of your bag`} when hit. Fills at the live pool price, so a fast dump can slip
            past your stop. If one order closes the position, the other is cancelled.
          </p>
        </>
      )}

      {quote && (
        <dl className="space-y-1.5 rounded-lg bg-zinc-900/60 p-3 text-xs">
          <div className="flex justify-between">
            <dt className="text-zinc-500">You receive</dt>
            <dd className="num text-white">
              {side === "buy" ? `${fmtTokens(quote.tokensOut)} ${pair.symbol}` : fmtSol(quote.solOut, 4)}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-zinc-500">Avg price</dt>
            <dd className="num">{fmtPrice(quote.avgPriceSol * solUsd)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-zinc-500">Price impact</dt>
            <dd className={`num ${impactClass(quote.priceImpact)}`}>{fmtPct(-quote.priceImpact * 100, 2)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-zinc-500">Fees ({+((pool?.fee ?? 0) * 100).toFixed(2)}% + priority)</dt>
            <dd className="num">{fmtSol(quote.feeSol, 4)}</dd>
          </div>
        </dl>
      )}
      {quote?.exceedsCurve && <p className="text-xs text-rose-400">Bigger than what&apos;s left on the bonding curve — try a smaller size.</p>}
      {quote && quote.priceImpact > 0.15 && (
        <p className="text-xs text-rose-400">⚠️ Huge price impact — this pool is too thin for that size.</p>
      )}

      {mode === "market" ? (
        <button
          onClick={submitMarket}
          disabled={!pool || (side === "sell" && !pos)}
          className={`w-full rounded-lg py-3 font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40 ${
            side === "buy" ? "bg-emerald-500 hover:bg-emerald-400" : "bg-rose-500 hover:bg-rose-400"
          }`}
        >
          {side === "buy" ? `Buy ${pair.symbol}` : `Sell ${pair.symbol}`}
        </button>
      ) : (
        <button
          onClick={submitTrigger}
          disabled={!pair.priceUsd || !!triggerError}
          className={`w-full rounded-lg py-3 font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40 ${
            side === "buy" ? "bg-emerald-500 hover:bg-emerald-400" : "bg-rose-500 hover:bg-rose-400"
          }`}
        >
          {side === "buy" ? "Place limit buy" : "Place TP / SL"}
        </button>
      )}
      {mode === "trigger" && triggerError && <p className="text-xs text-zinc-500">{triggerError}</p>}
      {!pool && mode === "market" && <p className="text-xs text-zinc-500">Waiting for price data…</p>}
      {flash && <p className={`text-sm ${flash.ok ? "text-emerald-400" : "text-rose-400"}`}>{flash.text}</p>}
    </div>
  );
}
