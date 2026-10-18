"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { NETWORK_FEE_SOL, poolFor, quoteBuy, quoteSell } from "./amm";
import { fmtPrice, fmtSol, fmtTokens } from "./format";
import type { Pair } from "./types";

export const STARTING_SOL = 10;
const STORAGE_KEY = "dgn.wallet.v1";

export type Position = {
  pairAddress: string;
  tokenAddress: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
  tokens: number;
  costSol: number;
  realizedSol: number;
  liquidityUsdAtEntry: number;
  openedAt: number;
  /** DexScreener dex id when opened; "pumpfun" means bought on the bonding curve. */
  dex?: string;
};

export type OrderKind = "limit_buy" | "take_profit" | "stop_loss";

export const ORDER_LABEL: Record<OrderKind, string> = {
  limit_buy: "Limit buy",
  take_profit: "Take profit",
  stop_loss: "Stop loss",
};

/** Short tag shown next to trades an order produced. */
export const ORDER_TAG: Record<OrderKind, string> = { limit_buy: "LIMIT", take_profit: "TP", stop_loss: "SL" };

export type Order = {
  id: string;
  createdAt: number;
  kind: OrderKind;
  pairAddress: string;
  tokenAddress?: string;
  /** Placed on a bonding-curve pair, so it must follow the token when it graduates. */
  curve?: boolean;
  symbol: string;
  imageUrl: string | null;
  /** Fires when price <= trigger (limit buy, stop loss) or >= trigger (take profit). */
  triggerPriceUsd: number;
  /** Price when the order was placed, for showing the distance. */
  refPriceUsd: number;
  /** Limit buys: SOL to spend. */
  solAmount?: number;
  /** Sells: fraction of the position held at trigger time. */
  fraction?: number;
  status: "open" | "filled" | "cancelled" | "failed";
  closedAt?: number;
  note?: string;
};

export type Trade = {
  id: string;
  ts: number;
  side: "buy" | "sell";
  pairAddress: string;
  symbol: string;
  solAmount: number;
  tokenAmount: number;
  priceUsd: number;
  priceImpact: number;
  feeSol: number;
  pnlSol?: number;
  /** Set when an order (rather than a market click) produced this trade. */
  orderKind?: OrderKind;
};

export type WalletState = {
  sol: number;
  startSol: number;
  realizedSol: number;
  feesSol: number;
  positions: Record<string, Position>;
  trades: Trade[];
  orders: Order[];
  createdAt: number;
};

export type Notice = { id: string; ok: boolean; text: string };

const fresh = (): WalletState => ({
  sol: STARTING_SOL,
  startSol: STARTING_SOL,
  realizedSol: 0,
  feesSol: 0,
  positions: {},
  trades: [],
  orders: [],
  createdAt: Date.now(),
});

type Applied = { ok: true; state: WalletState; trade: Trade } | { ok: false; error: string };
type Result = { ok: true; trade: Trade } | { ok: false; error: string };

function applyBuy(s: WalletState, pair: Pair, solUsd: number, solIn: number, orderKind?: OrderKind): Applied {
  const pool = poolFor(pair, solUsd);
  if (!pool) return { ok: false, error: "No liquidity data for this pair" };
  if (!(solIn > 0)) return { ok: false, error: "Enter an amount" };
  if (solIn + NETWORK_FEE_SOL > s.sol + 1e-12) return { ok: false, error: "Insufficient SOL" };
  const q = quoteBuy(pool, solIn);
  if (q.exceedsCurve) return { ok: false, error: "Bigger than what's left on the bonding curve — try a smaller size" };
  const trade: Trade = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    side: "buy",
    pairAddress: pair.pairAddress,
    symbol: pair.symbol,
    solAmount: solIn,
    tokenAmount: q.tokensOut,
    priceUsd: q.avgPriceSol * solUsd,
    priceImpact: q.priceImpact,
    feeSol: q.feeSol,
    orderKind,
  };
  const prev = s.positions[pair.pairAddress];
  const pos: Position = prev
    ? { ...prev, tokens: prev.tokens + q.tokensOut, costSol: prev.costSol + solIn + NETWORK_FEE_SOL }
    : {
        pairAddress: pair.pairAddress,
        tokenAddress: pair.tokenAddress,
        symbol: pair.symbol,
        name: pair.name,
        imageUrl: pair.imageUrl,
        tokens: q.tokensOut,
        costSol: solIn + NETWORK_FEE_SOL,
        realizedSol: 0,
        liquidityUsdAtEntry: pair.liquidityUsd,
        openedAt: Date.now(),
        dex: pair.dex,
      };
  return {
    ok: true,
    trade,
    state: {
      ...s,
      sol: s.sol - solIn - NETWORK_FEE_SOL,
      feesSol: s.feesSol + q.feeSol,
      positions: { ...s.positions, [pair.pairAddress]: pos },
      trades: [trade, ...s.trades].slice(0, 500),
    },
  };
}

function applySell(s: WalletState, pair: Pair, solUsd: number, fraction: number, orderKind?: OrderKind): Applied {
  const pos = s.positions[pair.pairAddress];
  if (!pos || pos.tokens <= 0) return { ok: false, error: "Nothing to sell" };
  const pool = poolFor(pair, solUsd);
  if (!pool) return { ok: false, error: "No liquidity data for this pair" };
  const f = Math.min(1, Math.max(0, fraction));
  const tokensIn = f >= 0.999 ? pos.tokens : pos.tokens * f;
  const q = quoteSell(pool, tokensIn);
  const costPortion = pos.costSol * (tokensIn / pos.tokens);
  const pnl = q.solOut - costPortion;
  const trade: Trade = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    side: "sell",
    pairAddress: pair.pairAddress,
    symbol: pair.symbol,
    solAmount: q.solOut,
    tokenAmount: tokensIn,
    priceUsd: q.avgPriceSol * solUsd,
    priceImpact: q.priceImpact,
    feeSol: q.feeSol,
    pnlSol: pnl,
    orderKind,
  };
  const positions = { ...s.positions };
  const remaining = pos.tokens - tokensIn;
  if (remaining <= pos.tokens * 1e-9) delete positions[pair.pairAddress];
  else
    positions[pair.pairAddress] = {
      ...pos,
      tokens: remaining,
      costSol: pos.costSol - costPortion,
      realizedSol: pos.realizedSol + pnl,
    };
  return {
    ok: true,
    trade,
    state: {
      ...s,
      sol: s.sol + q.solOut,
      realizedSol: s.realizedSol + pnl,
      feesSol: s.feesSol + q.feeSol,
      positions,
      trades: [trade, ...s.trades].slice(0, 500),
    },
  };
}

/** Once a position is gone, its remaining TP/SL orders have nothing to sell (one-cancels-other). */
function cancelOrphanedSells(s: WalletState, pairAddress: string): WalletState {
  if (s.positions[pairAddress]) return s;
  return {
    ...s,
    orders: s.orders.map((o) =>
      o.status === "open" && o.pairAddress === pairAddress && o.kind !== "limit_buy"
        ? { ...o, status: "cancelled", closedAt: Date.now(), note: "Position closed" }
        : o
    ),
  };
}

export const isTriggered = (o: Order, priceUsd: number) =>
  o.kind === "take_profit" ? priceUsd >= o.triggerPriceUsd : priceUsd <= o.triggerPriceUsd;

/** Re-key a position and its open orders from a completed bonding curve to the pool it graduated to. */
function applyMigration(s: WalletState, fromPairAddress: string, to: Pair): WalletState {
  const pos = s.positions[fromPairAddress];
  const positions = { ...s.positions };
  if (pos) {
    delete positions[fromPairAddress];
    const existing = positions[to.pairAddress];
    positions[to.pairAddress] = existing
      ? { ...existing, tokens: existing.tokens + pos.tokens, costSol: existing.costSol + pos.costSol, realizedSol: existing.realizedSol + pos.realizedSol }
      : { ...pos, pairAddress: to.pairAddress, imageUrl: pos.imageUrl ?? to.imageUrl, liquidityUsdAtEntry: to.liquidityUsd, dex: to.dex };
  }
  return {
    ...s,
    positions,
    orders: s.orders.map((o) => (o.status === "open" && o.pairAddress === fromPairAddress ? { ...o, pairAddress: to.pairAddress, curve: false } : o)),
  };
}

export type NewOrder = Omit<Order, "id" | "createdAt" | "status" | "closedAt" | "note">;

type WalletApi = {
  state: WalletState;
  hydrated: boolean;
  notices: Notice[];
  dismissNotice: (id: string) => void;
  notify: (ok: boolean, text: string) => void;
  buy: (pair: Pair, solUsd: number, solIn: number) => Result;
  sell: (pair: Pair, solUsd: number, fraction: number) => Result;
  placeOrders: (orders: NewOrder[]) => void;
  cancelOrder: (id: string) => void;
  /** Check open orders against fresh prices and execute any that triggered. */
  runOrders: (pairs: Record<string, Pair>, solUsd: number) => void;
  /** Move holdings and orders from a graduated bonding curve to its new pool. */
  migrate: (fromPairAddress: string, to: Pair) => void;
  reset: (startSol?: number) => void;
};

const WalletContext = createContext<WalletApi | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<WalletState>(fresh);
  const [hydrated, setHydrated] = useState(false);
  const [notices, setNotices] = useState<Notice[]>([]);
  // Mirror of the latest state so actions fired in the same tick (e.g. several orders) see each other's effects.
  const ref = useRef(state);

  const commit = useCallback((next: WalletState) => {
    ref.current = next;
    setState(next);
  }, []);

  const notify = useCallback((ok: boolean, text: string) => {
    setNotices((n) => [...n.slice(-4), { id: crypto.randomUUID(), ok, text }]);
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) commit({ ...fresh(), ...JSON.parse(raw) });
    } catch {}
    setHydrated(true);
  }, [commit]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {}
  }, [state, hydrated]);

  const buy = useCallback(
    (pair: Pair, solUsd: number, solIn: number): Result => {
      const r = applyBuy(ref.current, pair, solUsd, solIn);
      if (!r.ok) return r;
      commit(r.state);
      return { ok: true, trade: r.trade };
    },
    [commit]
  );

  const sell = useCallback(
    (pair: Pair, solUsd: number, fraction: number): Result => {
      const r = applySell(ref.current, pair, solUsd, fraction);
      if (!r.ok) return r;
      commit(cancelOrphanedSells(r.state, pair.pairAddress));
      return { ok: true, trade: r.trade };
    },
    [commit]
  );

  const placeOrders = useCallback(
    (orders: NewOrder[]) => {
      const created: Order[] = orders.map((o) => ({ ...o, id: crypto.randomUUID(), createdAt: Date.now(), status: "open" }));
      commit({ ...ref.current, orders: [...created, ...ref.current.orders].slice(0, 300) });
    },
    [commit]
  );

  const cancelOrder = useCallback(
    (id: string) => {
      commit({
        ...ref.current,
        orders: ref.current.orders.map((o) =>
          o.id === id && o.status === "open" ? { ...o, status: "cancelled", closedAt: Date.now(), note: "Cancelled" } : o
        ),
      });
    },
    [commit]
  );

  const runOrders = useCallback(
    (pairs: Record<string, Pair>, solUsd: number) => {
      if (!solUsd) return;
      let s = ref.current;
      let changed = false;
      const close = (id: string, status: Order["status"], note: string) => {
        s = { ...s, orders: s.orders.map((o) => (o.id === id ? { ...o, status, closedAt: Date.now(), note } : o)) };
        changed = true;
      };
      for (const id of s.orders.filter((o) => o.status === "open").map((o) => o.id)) {
        const o = s.orders.find((x) => x.id === id);
        // An earlier fill this tick may have cancelled it.
        if (!o || o.status !== "open") continue;
        const pair = pairs[o.pairAddress];
        if (!pair?.priceUsd || !isTriggered(o, pair.priceUsd)) continue;
        const r =
          o.kind === "limit_buy"
            ? applyBuy(s, pair, solUsd, o.solAmount ?? 0, o.kind)
            : applySell(s, pair, solUsd, o.fraction ?? 1, o.kind);
        if (!r.ok) {
          close(o.id, "failed", r.error);
          notify(false, `${ORDER_LABEL[o.kind]} ${o.symbol} failed: ${r.error}`);
          continue;
        }
        s = r.state;
        close(o.id, "filled", `Filled @ ${fmtPrice(r.trade.priceUsd)}`);
        if (o.kind !== "limit_buy") s = cancelOrphanedSells(s, o.pairAddress);
        const t = r.trade;
        notify(
          true,
          t.side === "buy"
            ? `${ORDER_LABEL[o.kind]} filled: bought ${fmtTokens(t.tokenAmount)} ${t.symbol} for ${fmtSol(t.solAmount)}`
            : `${ORDER_LABEL[o.kind]} filled: sold ${t.symbol} for ${fmtSol(t.solAmount)} (${t.pnlSol! >= 0 ? "+" : ""}${t.pnlSol!.toFixed(3)} SOL)`
        );
      }
      if (changed) commit(s);
    },
    [commit, notify]
  );

  const migrate = useCallback(
    (fromPairAddress: string, to: Pair) => {
      const s = ref.current;
      const affected = s.positions[fromPairAddress] || s.orders.some((o) => o.status === "open" && o.pairAddress === fromPairAddress);
      if (!affected || fromPairAddress === to.pairAddress) return;
      commit(applyMigration(s, fromPairAddress, to));
      notify(true, `🎓 ${to.symbol} graduated to ${to.dex === "pumpswap" ? "PumpSwap" : to.dex} — your position and orders moved over`);
    },
    [commit, notify]
  );

  const reset = useCallback(
    (startSol = STARTING_SOL) => {
      commit({ ...fresh(), sol: startSol, startSol });
    },
    [commit]
  );

  const dismissNotice = useCallback((id: string) => setNotices((n) => n.filter((x) => x.id !== id)), []);

  const api = useMemo(
    () => ({ state, hydrated, notices, dismissNotice, notify, buy, sell, placeOrders, cancelOrder, runOrders, migrate, reset }),
    [state, hydrated, notices, dismissNotice, notify, buy, sell, placeOrders, cancelOrder, runOrders, migrate, reset]
  );
  return <WalletContext.Provider value={api}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside WalletProvider");
  return ctx;
}
