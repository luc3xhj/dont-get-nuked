// Market regime: when NOT to trade (playbook §6). A transparent gate, not a prediction:
//   bad     → no new entries
//   caution → half size
// Inputs: SOL's 1h move (implied from our own quotes), how many coins graduated recently
// (real demand), and whether setups have been working lately (the every-setup benchmark).
import { db } from "./db";
import { coins, graduations, stats } from "./state";

export type Regime = {
  level: "good" | "caution" | "bad";
  reasons: string[];
  solUsd: number | null;
  solChange1h: number | null;
  graduations2h: number | null;
  launches1h: number;
  benchmarkAvgR: number | null;
  benchmarkTrades: number;
  at: number;
};

const RULES = {
  solDropBad: -0.05,
  solDropCaution: -0.025,
  minGraduations2h: 2,
  benchmarkWindow: 20,
  benchmarkMinTrades: 10,
  benchmarkBadR: -0.5,
};

const solHistory: [number, number][] = [];
export let regime: Regime = {
  level: "good",
  reasons: ["Warming up"],
  solUsd: null,
  solChange1h: null,
  graduations2h: null,
  launches1h: 0,
  benchmarkAvgR: null,
  benchmarkTrades: 0,
  at: 0,
};

/** SOL/USD implied by our fresh coin quotes (priceUsd / priceSol); median to ignore outliers. */
function impliedSolUsd(): number | null {
  const now = Date.now();
  const xs = [...coins.values()]
    .map((s) => s.quote)
    .filter((q): q is NonNullable<typeof q> => !!q && now - q.at < 30_000 && q.priceSol > 0 && q.priceUsd > 0)
    .map((q) => q.priceUsd / q.priceSol)
    .sort((a, b) => a - b);
  return xs.length ? xs[xs.length >> 1] : null;
}

export function regimeTick() {
  const now = Date.now();
  const sol = impliedSolUsd();
  if (sol) solHistory.push([now, sol]);
  while (solHistory.length && now - solHistory[0][0] > 3 * 3600_000) solHistory.shift();
  const hourAgo = solHistory.find(([t]) => t >= now - 3600_000);
  const solChange1h = sol && hourAgo && now - hourAgo[0] > 45 * 60_000 ? sol / hourAgo[1] - 1 : null;

  // Graduations are only countable once we've been watching long enough.
  const uptimeMin = (now - stats.startedAt) / 60_000;
  const graduations2h = uptimeMin >= 60 ? graduations.filter((t) => now - t <= 2 * 3600_000).length : null;
  const launches1h = [...coins.values()].filter((s) => now - s.coin.createdAt <= 3600_000).length;

  const recent = (
    db
      .prepare("SELECT json_extract(data, '$.r') AS r FROM closed WHERE account = 'shadow' ORDER BY closed_at DESC LIMIT ?")
      .all(RULES.benchmarkWindow) as {
      r: number;
    }[]
  ).map((x) => x.r);
  const benchmarkAvgR = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : null;

  const bad: string[] = [];
  const caution: string[] = [];
  if (solChange1h !== null && solChange1h <= RULES.solDropBad) bad.push(`SOL ${(solChange1h * 100).toFixed(1)}% in 1h`);
  else if (solChange1h !== null && solChange1h <= RULES.solDropCaution) caution.push(`SOL ${(solChange1h * 100).toFixed(1)}% in 1h`);
  if (benchmarkAvgR !== null && recent.length >= RULES.benchmarkMinTrades) {
    if (benchmarkAvgR <= RULES.benchmarkBadR)
      bad.push(`setups averaging ${benchmarkAvgR.toFixed(2)}R over the last ${recent.length} benchmark trades`);
    else if (benchmarkAvgR < 0) caution.push(`setups averaging ${benchmarkAvgR.toFixed(2)}R lately`);
  }
  if (graduations2h !== null && graduations2h < RULES.minGraduations2h) caution.push(`only ${graduations2h} graduations in 2h (thin demand)`);

  regime = {
    level: bad.length ? "bad" : caution.length ? "caution" : "good",
    reasons: bad.length ? bad : caution.length ? caution : ["Market conditions normal"],
    solUsd: sol,
    solChange1h,
    graduations2h,
    launches1h,
    benchmarkAvgR,
    benchmarkTrades: recent.length,
    at: now,
  };
}
