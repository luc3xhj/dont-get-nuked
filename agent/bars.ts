// Completed-bar candles built from our own recorded tape (V2 §08). A bar is usable only after its
// interval has ended; a bar inside a tape gap is "missing", which is different from "empty" (no trades).
// Highs and lows of a bar never authorize an earlier intrabar fill.
import { db } from "./db";
import type { CoinState } from "./state";

export type Bar = {
  start: number;
  end: number;
  open: number;
  high: number;
  low: number;
  close: number;
  buySol: number;
  sellSol: number;
  buyers: number;
  trades: number;
  /** "ok" with trades, "empty" (covered but no trades), or "missing" (outside the covered tape). */
  state: "ok" | "empty" | "missing";
};

type Pt = { ts: number; priceSol: number; side: "buy" | "sell"; sol: number; wallet: string };

/** Bars of `intervalMs` that have fully completed by `now`, over `[from, now)`, from trades `pts` covering `[coveredFrom, now]`. */
export function buildBars(pts: Pt[], intervalMs: number, from: number, now: number, coveredFrom: number | null): Bar[] {
  const out: Bar[] = [];
  const first = Math.floor(from / intervalMs) * intervalMs;
  const lastEnd = Math.floor(now / intervalMs) * intervalMs; // bars ending after `now` are not complete
  let i = 0;
  const sorted = [...pts].sort((a, b) => a.ts - b.ts);
  let prevClose: number | null = null;
  for (let start = first; start + intervalMs <= lastEnd; start += intervalMs) {
    const end = start + intervalMs;
    while (i < sorted.length && sorted[i].ts < start) i++;
    let j = i;
    const inBar: Pt[] = [];
    while (j < sorted.length && sorted[j].ts < end) inBar.push(sorted[j++]);
    const covered = coveredFrom !== null && start >= coveredFrom;
    if (!covered) {
      out.push({ start, end, open: NaN, high: NaN, low: NaN, close: NaN, buySol: 0, sellSol: 0, buyers: 0, trades: 0, state: "missing" });
      continue;
    }
    if (!inBar.length) {
      const p = prevClose ?? NaN;
      out.push({ start, end, open: p, high: p, low: p, close: p, buySol: 0, sellSol: 0, buyers: 0, trades: 0, state: "empty" });
      continue;
    }
    const prices = inBar.map((t) => t.priceSol);
    const bar: Bar = {
      start,
      end,
      open: prices[0],
      high: Math.max(...prices),
      low: Math.min(...prices),
      close: prices[prices.length - 1],
      buySol: inBar.filter((t) => t.side === "buy").reduce((a, t) => a + t.sol, 0),
      sellSol: inBar.filter((t) => t.side === "sell").reduce((a, t) => a + t.sol, 0),
      buyers: new Set(inBar.filter((t) => t.side === "buy").map((t) => t.wallet)).size,
      trades: inBar.length,
      state: "ok",
    };
    prevClose = bar.close;
    out.push(bar);
  }
  return out;
}

/** Bars for a coin from the in-memory tape, or the stored tape when it reaches further back. */
export function barsFor(s: CoinState, intervalMs: number, lookbackMs: number, now = Date.now()): Bar[] {
  const from = now - lookbackMs;
  let pts: Pt[] = s.trades.filter((t) => t.ts >= from && t.sol >= 0.005);
  let coveredFrom = s.trades[0]?.ts ?? null;
  if (!s.trades.length || s.trades[0].ts > from) {
    const stored = db
      .prepare("SELECT ts, price_sol AS priceSol, side, sol, wallet FROM trades WHERE mint = ? AND ts >= ? AND sol >= 0.005 ORDER BY ts")
      .all(s.coin.mint, from) as Pt[];
    if (stored.length > pts.length) {
      pts = stored;
      coveredFrom = stored[0]?.ts ?? coveredFrom;
    }
  }
  // Gaps since the start of coverage make the whole window unreliable for structure: mark it missing.
  if (s.tapeGaps > 0) coveredFrom = now;
  return buildBars(pts, intervalMs, from, now, coveredFrom);
}

/** Average true range over the last `n` usable bars (simple mean; prior close carried across empty bars). */
export function atr(bars: Bar[], n: number): number | null {
  const ok = bars.filter((b) => b.state !== "missing" && Number.isFinite(b.close));
  if (ok.length < n + 1) return null;
  const trs: number[] = [];
  for (let i = ok.length - n; i < ok.length; i++) {
    const b = ok[i];
    const pc = ok[i - 1].close;
    trs.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)));
  }
  return trs.reduce((a, v) => a + v, 0) / n;
}

/** Hours of continuous coverage ending now (for long-horizon contracts). */
export const coverageHours = (bars: Bar[]) => {
  let n = 0;
  for (let i = bars.length - 1; i >= 0 && bars[i].state !== "missing"; i--) n++;
  return bars.length ? (n * (bars[0].end - bars[0].start)) / 3600_000 : 0;
};
