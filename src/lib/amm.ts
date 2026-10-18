// Simulated swap execution against a constant-product (x*y=k) pool, using the
// pair's real reserves so size actually moves the price like it would on-chain.
import type { Pair } from "./types";

/** LP + trading-bot fee taken on the SOL side of every DEX swap. */
export const SWAP_FEE = 0.005;
/** pump.fun bonding-curve fee (protocol + creator). */
export const CURVE_FEE = 0.0125;
/** Base + priority fee paid per transaction, in SOL. */
export const NETWORK_FEE_SOL = 0.0005;

// pump.fun bonding curve: constant product over virtual reserves that start at
// 30 SOL / 1.073B tokens. It completes (graduates to PumpSwap) once 793.1M
// tokens have been bought, i.e. when virtual token reserves hit 279.9M.
const CURVE_V_SOL = 30;
const CURVE_V_TOKENS = 1_073_000_000;
const CURVE_END_V_TOKENS = 279_900_000;
const CURVE_K = CURVE_V_SOL * CURVE_V_TOKENS;

export const isBondingCurve = (pair: Pair) => pair.dex === "pumpfun";

/** Virtual token reserves implied by the curve price (in SOL). */
const curveTokens = (priceSol: number) => Math.sqrt(CURVE_K / priceSol);

/** 0–1 progress toward graduation, or null if the pair isn't on a bonding curve. */
export function curveProgress(pair: Pair): number | null {
  if (!isBondingCurve(pair) || !pair.priceNative) return null;
  const sold = CURVE_V_TOKENS - curveTokens(pair.priceNative);
  return Math.min(1, Math.max(0, sold / (CURVE_V_TOKENS - CURVE_END_V_TOKENS)));
}

export type Pool = {
  reserveSol: number;
  reserveTokens: number;
  spotPriceSol: number;
  fee: number;
  /** Bonding curve only: tokens left before the curve completes. */
  curveTokensLeft: number | null;
};

/** Reserves expressed in SOL, scaled so reserveSol / reserveTokens equals the quoted price. */
export function poolFor(pair: Pair, solUsd: number): Pool | null {
  if (isBondingCurve(pair)) {
    // DexScreener reports no liquidity for curves, but the curve's reserves follow from its price.
    const spotPriceSol = pair.priceNative;
    if (!spotPriceSol) return null;
    const reserveTokens = curveTokens(spotPriceSol);
    return {
      reserveSol: CURVE_K / reserveTokens,
      reserveTokens,
      spotPriceSol,
      fee: CURVE_FEE,
      curveTokensLeft: Math.max(0, reserveTokens - CURVE_END_V_TOKENS),
    };
  }
  if (!pair.priceUsd || !solUsd) return null;
  const spotPriceSol = pair.priceUsd / solUsd;
  const quoteUsd = pair.priceNative ? pair.priceUsd / pair.priceNative : 0;
  let reserveSol = pair.reserveQuote && quoteUsd ? (pair.reserveQuote * quoteUsd) / solUsd : 0;
  if (!reserveSol) reserveSol = pair.liquidityUsd / 2 / solUsd;
  if (!reserveSol) return null;
  return { reserveSol, reserveTokens: reserveSol / spotPriceSol, spotPriceSol, fee: SWAP_FEE, curveTokensLeft: null };
}

export type Quote = {
  solIn: number;
  solOut: number;
  tokensIn: number;
  tokensOut: number;
  feeSol: number;
  /** Fraction worse than spot because of pool depth (excludes fees). */
  priceImpact: number;
  /** Average execution price in SOL per token (after fees). */
  avgPriceSol: number;
  /** Bonding curve only: the buy is bigger than what's left on the curve. */
  exceedsCurve: boolean;
};

export function quoteBuy(pool: Pool, solIn: number): Quote {
  const swapFee = solIn * pool.fee;
  const net = solIn - swapFee;
  const tokensOut = (pool.reserveTokens * net) / (pool.reserveSol + net);
  const ideal = net / pool.spotPriceSol;
  return {
    solIn,
    solOut: 0,
    tokensIn: 0,
    tokensOut,
    feeSol: swapFee + NETWORK_FEE_SOL,
    priceImpact: ideal > 0 ? 1 - tokensOut / ideal : 0,
    avgPriceSol: tokensOut > 0 ? solIn / tokensOut : 0,
    exceedsCurve: pool.curveTokensLeft !== null && tokensOut > pool.curveTokensLeft,
  };
}

export function quoteSell(pool: Pool, tokensIn: number): Quote {
  const gross = (pool.reserveSol * tokensIn) / (pool.reserveTokens + tokensIn);
  const swapFee = gross * pool.fee;
  const ideal = tokensIn * pool.spotPriceSol;
  return {
    solIn: 0,
    solOut: Math.max(0, gross - swapFee - NETWORK_FEE_SOL),
    tokensIn,
    tokensOut: 0,
    feeSol: swapFee + NETWORK_FEE_SOL,
    priceImpact: ideal > 0 ? 1 - gross / ideal : 0,
    avgPriceSol: tokensIn > 0 ? (gross - swapFee) / tokensIn : 0,
    exceedsCurve: false,
  };
}
