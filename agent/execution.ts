// Execution simulator: orders fill only against a fresh quote that arrives AFTER the decision
// plus latency, using real curve / pool reserves and the app's AMM math. No look-ahead.
import { NETWORK_FEE_SOL, poolFor, quoteBuy, quoteSell } from "../src/lib/amm";
import type { Pair } from "../src/lib/types";
import type { CoinState } from "./state";

export const EXEC = {
  minLatencyMs: 1_500,
  maxLatencyMs: 3_000,
  /** Extra adverse move on every fill (MEV, priority-fee races, stale reserves). */
  adverseSlippage: 0.01,
  failRate: 0.03,
  /** Buys are rejected if the fill is this much worse than the price we decided on. */
  maxBuySlippage: 0.1,
  quoteMaxAgeMs: 10_000,
  orderTimeoutMs: 30_000,
};

/** Deterministic uniform [0, 1) stream from a string seed (FNV-1a + mulberry32), for reproducible fills. */
export function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function toPair(s: CoinState): Pair | null {
  const q = s.quote;
  if (!q || !q.priceSol || !q.priceUsd) return null;
  const c = s.coin;
  return {
    pairAddress: c.stage === "migrated" && c.pool ? c.pool : c.curve,
    tokenAddress: c.mint,
    name: c.name,
    symbol: c.symbol,
    dex: c.stage === "curve" ? "pumpfun" : "pumpswap",
    imageUrl: null,
    url: "",
    priceUsd: q.priceUsd,
    priceNative: q.priceSol,
    quoteSymbol: "SOL",
    liquidityUsd: q.liquidityUsd,
    reserveBase: q.reserveTokens,
    reserveQuote: q.reserveSol,
    fdv: q.mcapUsd,
    marketCap: q.mcapUsd,
    volume24h: 0,
    change: { m5: 0, h1: 0, h6: 0, h24: 0 },
    txns24h: { buys: 0, sells: 0 },
    createdAt: c.createdAt,
  };
}

/** SOL price implied by the coin's own quote. */
const solUsdOf = (s: CoinState) => (s.quote && s.quote.priceSol ? s.quote.priceUsd / s.quote.priceSol : 0);

export function poolOf(s: CoinState) {
  const pair = toPair(s);
  return pair ? poolFor(pair, solUsdOf(s)) : null;
}

/** Round-trip cost estimate as a fraction of size, for EV math before we trade. */
export function roundTripCost(s: CoinState, sizeSol: number) {
  const pool = poolOf(s);
  const fee = pool?.fee ?? 0.0125;
  return 2 * fee + 2 * EXEC.adverseSlippage + (2 * NETWORK_FEE_SOL) / Math.max(sizeSol, 0.01);
}

/** Largest buy that keeps our own price impact under `maxImpact`. */
export function maxSizeForImpact(s: CoinState, maxImpact: number) {
  const pool = poolOf(s);
  if (!pool) return 0;
  // Constant product: impact ≈ x / (R + x)  ⇒  x = R * i / (1 - i)
  return (pool.reserveSol * maxImpact) / (1 - maxImpact);
}

export type Fill =
  { ok: true; sol: number; tokens: number; priceSol: number; feeSol: number; impact: number } | { ok: false; reason: string; feeSol: number };

const freshQuote = (s: CoinState, after: number) => !!s.quote && s.quote.at >= after && Date.now() - s.quote.at <= EXEC.quoteMaxAgeMs;

/** `failDraw` is a seeded uniform draw for this order, so simulated failures replay identically. */
export function fillBuy(s: CoinState, solIn: number, decisionPriceSol: number, notBefore: number, failDraw: number): Fill | "wait" {
  if (!freshQuote(s, notBefore)) return "wait";
  if (failDraw < EXEC.failRate) return { ok: false, reason: "transaction failed", feeSol: NETWORK_FEE_SOL };
  const pool = poolOf(s);
  if (!pool) return { ok: false, reason: "no pool data", feeSol: 0 };
  const q = quoteBuy(pool, solIn);
  if (q.exceedsCurve) return { ok: false, reason: "bigger than the rest of the curve", feeSol: NETWORK_FEE_SOL };
  const tokens = q.tokensOut * (1 - EXEC.adverseSlippage);
  const priceSol = solIn / tokens;
  if (priceSol > decisionPriceSol * (1 + EXEC.maxBuySlippage))
    return { ok: false, reason: `price ran ${((priceSol / decisionPriceSol - 1) * 100).toFixed(0)}% past entry`, feeSol: NETWORK_FEE_SOL };
  return { ok: true, sol: solIn + NETWORK_FEE_SOL, tokens, priceSol, feeSol: q.feeSol, impact: q.priceImpact };
}

export function fillSell(s: CoinState, tokensIn: number, notBefore: number, failDraw: number): Fill | "wait" {
  if (!freshQuote(s, notBefore)) return "wait";
  if (failDraw < EXEC.failRate) return { ok: false, reason: "transaction failed", feeSol: NETWORK_FEE_SOL };
  const pool = poolOf(s);
  if (!pool) return { ok: false, reason: "no pool data", feeSol: 0 };
  const q = quoteSell(pool, tokensIn);
  const sol = q.solOut * (1 - EXEC.adverseSlippage);
  return { ok: true, sol, tokens: tokensIn, priceSol: sol / tokensIn, feeSol: q.feeSol, impact: q.priceImpact };
}

/** Mark-to-market: what selling everything would fetch right now (fees and impact included). */
export function liquidationValue(s: CoinState, tokens: number): number | null {
  const pool = poolOf(s);
  if (!pool || !s.quote || Date.now() - s.quote.at > 5 * 60_000) return null;
  return quoteSell(pool, tokens).solOut;
}

export const latency = (draw: number) => EXEC.minLatencyMs + draw * (EXEC.maxLatencyMs - EXEC.minLatencyMs);
