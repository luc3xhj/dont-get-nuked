"use client";

import { useEffect } from "react";
import { isBondingCurve } from "@/lib/amm";
import { useGraduated, usePairs, useSolPrice } from "@/lib/hooks";
import { useWallet } from "@/lib/wallet";

/**
 * Watches live prices for every held pair and pair with an open order: fills orders as they
 * trigger, and moves holdings over when a pump.fun curve graduates to PumpSwap.
 * Runs on every page (and keeps polling in background tabs), but only while the app is open.
 */
export default function OrderEngine() {
  const { state, hydrated, runOrders, migrate } = useWallet();
  const openOrders = hydrated ? state.orders.filter((o) => o.status === "open") : [];
  const positions = hydrated ? Object.values(state.positions) : [];
  const watched = [...positions.map((p) => p.pairAddress), ...openOrders.map((o) => o.pairAddress)];
  const solUsd = useSolPrice(true);
  const { pairs, updatedAt } = usePairs(watched, 3_000, true);

  // Curve pair -> token. Taken from what we stored at entry as well as live data, because a
  // graduated curve can disappear from the data APIs entirely.
  const curves: Record<string, string> = {};
  for (const p of positions) if (p.dex === "pumpfun") curves[p.pairAddress] = p.tokenAddress;
  for (const o of openOrders) if (o.curve && o.tokenAddress) curves[o.pairAddress] = o.tokenAddress;
  for (const p of Object.values(pairs)) if (isBondingCurve(p)) curves[p.pairAddress] = p.tokenAddress;
  const graduated = useGraduated(Object.values(curves), true);

  useEffect(() => {
    if (updatedAt) runOrders(pairs, solUsd);
    // `pairs` is rebuilt every render; a new fetch is signalled by `updatedAt`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updatedAt, solUsd, runOrders]);

  useEffect(() => {
    for (const [pairAddress, token] of Object.entries(curves)) {
      const to = graduated[token];
      if (to) migrate(pairAddress, to);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graduated, migrate]);

  return null;
}
