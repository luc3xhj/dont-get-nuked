// Deterministic features computed from a coin's trade tape. All prices in SOL.
import { CONFIG } from "./config";
import type { CoinState } from "./state";
import type { Cohort, Features, Flow, Trade } from "./types";

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function flow(trades: Trade[], from: number, to: number, firstSeen: Map<string, number>): Flow {
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let sells = 0;
  const buyers = new Set<string>();
  const sellers = new Set<string>();
  const buySizes: number[] = [];
  const volByWallet = new Map<string, number>();
  for (const t of trades) {
    if (t.ts < from || t.ts > to) continue;
    volByWallet.set(t.wallet, (volByWallet.get(t.wallet) ?? 0) + t.sol);
    if (t.side === "buy") {
      buySol += t.sol;
      buys++;
      buyers.add(t.wallet);
      buySizes.push(t.sol);
    } else {
      sellSol += t.sol;
      sells++;
      sellers.add(t.wallet);
    }
  }
  let newBuyers = 0;
  for (const w of buyers) if ((firstSeen.get(w) ?? 0) >= from) newBuyers++;
  let roundTripVol = 0;
  let totalVol = 0;
  for (const [w, v] of volByWallet) {
    totalVol += v;
    if (buyers.has(w) && sellers.has(w)) roundTripVol += v;
  }
  return {
    buySol,
    sellSol,
    netSol: buySol - sellSol,
    buys,
    sells,
    buyers: buyers.size,
    sellers: sellers.size,
    newBuyerShare: buyers.size ? newBuyers / buyers.size : 0,
    medianBuySol: median(buySizes),
    maxBuySol: buySizes.length ? Math.max(...buySizes) : 0,
    roundTripShare: totalVol ? roundTripVol / totalVol : 0,
  };
}

function cohort(trades: Trade[], wallets: Set<string>, now: number): Cohort {
  let bought = 0;
  let sold = 0;
  let sellSol60s = 0;
  const held = new Map<string, number>();
  for (const t of trades) {
    if (!wallets.has(t.wallet)) continue;
    const h = held.get(t.wallet) ?? 0;
    if (t.side === "buy") {
      bought += t.tokens;
      held.set(t.wallet, h + t.tokens);
    } else {
      sold += t.tokens;
      // Tokens can arrive by transfer, which the tape doesn't show; never go negative.
      held.set(t.wallet, Math.max(0, h - t.tokens));
      if (t.ts >= now - 60_000) sellSol60s += t.sol;
    }
  }
  const heldTokens = [...held.values()].reduce((a, b) => a + b, 0);
  return {
    wallets: wallets.size,
    heldPct: (heldTokens / CONFIG.totalSupply) * 100,
    soldFraction: bought ? Math.min(1, sold / bought) : 0,
    sellSol60s,
  };
}

/** Sell SOL from a cohort within [from, to). */
function cohortSellSol(trades: Trade[], wallets: Set<string>, from: number, to: number) {
  let sol = 0;
  for (const t of trades) if (t.side === "sell" && t.ts >= from && t.ts < to && wallets.has(t.wallet)) sol += t.sol;
  return sol;
}

export function computeFeatures(s: CoinState, now = Date.now()): Features | null {
  const trades = s.trades;
  if (trades.length < 5) return null;
  const c = CONFIG.cohorts;

  const firstSeen = new Map<string, number>();
  for (const t of trades) if (!firstSeen.has(t.wallet)) firstSeen.set(t.wallet, t.ts);

  // ---- price structure ----
  const last = trades.at(-1)!;
  // Between tape polls the DexScreener quote is the freshest price.
  const q = s.quote;
  const priceSol = q && q.at > last.ts && q.priceSol > 0 ? q.priceSol : last.priceSol;
  let athIdx = 0;
  for (let i = 1; i < trades.length; i++) if (trades[i].priceSol > trades[athIdx].priceSol) athIdx = i;
  const ath = Math.max(trades[athIdx].priceSol, priceSol);
  let lowAfterAth = ath;
  let lowIdx = athIdx;
  for (let i = athIdx; i < trades.length; i++)
    if (trades[i].priceSol < lowAfterAth) {
      lowAfterAth = trades[i].priceSol;
      lowIdx = i;
    }
  const win10 = trades.filter((t) => t.ts >= now - 10 * 60_000);
  const hi10 = win10.length ? Math.max(...win10.map((t) => t.priceSol)) : priceSol;
  const lo10 = win10.length ? Math.min(...win10.map((t) => t.priceSol)) : priceSol;
  // Higher low: the lowest price in the last 2 minutes sits above the post-ATH low, which happened earlier.
  const recent = trades.filter((t) => t.ts >= now - 120_000);
  const recentLow = recent.length ? Math.min(...recent.map((t) => t.priceSol)) : priceSol;
  const higherLow = trades[lowIdx].ts < now - 120_000 && recentLow > lowAfterAth * 1.03;

  // ---- cohorts ----
  const launchSlot = s.fromLaunch ? trades[0].slot : null;
  const dev = new Set<string>([s.coin.creator]);
  const snipers = new Set<string>();
  const bundles = new Set<string>();
  const early = new Set<string>();
  if (launchSlot !== null) {
    const bySlot = new Map<number, Set<string>>();
    for (const t of trades) {
      if (t.side !== "buy" || t.wallet === s.coin.creator) continue;
      if (t.slot <= launchSlot + c.sniperSlots) snipers.add(t.wallet);
      if (t.slot <= launchSlot + c.bundleWindowSlots) {
        const set = bySlot.get(t.slot) ?? new Set<string>();
        set.add(t.wallet);
        bySlot.set(t.slot, set);
      }
      if (early.size < c.earlyBuyers) early.add(t.wallet);
    }
    for (const set of bySlot.values()) if (set.size >= c.bundleMinWallets) for (const w of set) bundles.add(w);
  }
  const insiders = new Set([...dev, ...snipers, ...bundles, ...early]);

  // ---- exhaustion: selling slowed down and price stopped making new lows ----
  // Launch cohorts when the tape reaches launch; otherwise every seller on the tape.
  const basis = launchSlot !== null ? "cohorts" : "all-sellers";
  const sellers = basis === "cohorts" ? insiders : new Set(trades.map((t) => t.wallet));
  const sellNow = cohortSellSol(trades, sellers, now - 60_000, now);
  const sellBefore = cohortSellSol(trades, sellers, now - 240_000, now - 60_000) / 3;
  const notNewLow = trades[lowIdx].ts < now - 60_000;
  let exhaustion = 0;
  if (sellBefore > 0.05) exhaustion = Math.max(0, Math.min(1, 1 - sellNow / sellBefore));
  else if (sellNow < 0.05) exhaustion = 0.5; // nothing much to exhaust; neutral
  if (!notNewLow) exhaustion *= 0.3;
  // No trades at all in the last minute is a dead coin, not an exhausted seller.
  const idle = !trades.some((t) => t.ts >= now - 60_000);

  // ---- dump anatomy: who sold from the top, and is the base holding? ----
  const soldSinceAth = new Map<string, number>();
  for (let i = athIdx; i < trades.length; i++) {
    const t = trades[i];
    soldSinceAth.set(t.wallet, (soldSinceAth.get(t.wallet) ?? 0) + (t.side === "sell" ? t.tokens : -t.tokens));
  }
  let topSeller: string | null = null;
  let topSold = 0;
  for (const [w, v] of soldSinceAth)
    if (v > topSold) {
      topSold = v;
      topSeller = w;
    }
  const topSellerActive = !!topSeller && trades.some((t) => t.wallet === topSeller && t.side === "sell" && t.ts >= now - 60_000);
  // Minutes the price has stayed within 30% above the post-ATH low (a base forming).
  let baseSince = now;
  for (let i = trades.length - 1; i > lowIdx; i--) {
    if (trades[i].priceSol > lowAfterAth * 1.3) break;
    baseSince = trades[i].ts;
  }
  if (priceSol > lowAfterAth * 1.3) baseSince = now;

  // ---- bump bots: the same wallet buying the same size over and over ----
  const buys5m = trades.filter((t) => t.side === "buy" && t.ts >= now - 300_000);
  const sizeCount = new Map<string, number>();
  for (const t of buys5m) {
    const k = `${t.wallet}:${t.sol.toFixed(3)}`;
    sizeCount.set(k, (sizeCount.get(k) ?? 0) + 1);
  }
  let repeats = 0;
  for (const t of buys5m) if ((sizeCount.get(`${t.wallet}:${t.sol.toFixed(3)}`) ?? 0) >= 2) repeats++;

  return {
    at: now,
    ageMin: (now - (s.coin.createdAt || trades[0].ts)) / 60_000,
    stage: s.coin.stage,
    priceSol,
    mcapSol: priceSol * CONFIG.totalSupply,
    athMcapSol: ath * CONFIG.totalSupply,
    drawdown: ath ? 1 - priceSol / ath : 0,
    minSinceAth: (now - trades[athIdx].ts) / 60_000,
    bounceFromLow: lowAfterAth ? priceSol / lowAfterAth - 1 : 0,
    lowSol: lowAfterAth,
    lowAgeMin: (now - trades[lowIdx].ts) / 60_000,
    maxDrawdown: ath ? 1 - lowAfterAth / ath : 0,
    baseMin: (now - baseSince) / 60_000,
    range10m: lo10 ? hi10 / lo10 - 1 : 0,
    hi10Sol: hi10,
    lo10Sol: lo10,
    topSellerPct: (topSold / CONFIG.totalSupply) * 100,
    topSellerActive,
    repeatBuyShare: buys5m.length ? repeats / buys5m.length : 0,
    higherLow,
    curveProgress: s.coin.curveProgress,
    flow15s: flow(trades, now - 15_000, now, firstSeen),
    flow60s: flow(trades, now - 60_000, now, firstSeen),
    flow5m: flow(trades, now - 300_000, now, firstSeen),
    cohorts: {
      dev: cohort(trades, dev, now),
      snipers: cohort(trades, snipers, now),
      bundles: cohort(trades, bundles, now),
      early: cohort(trades, early, now),
      insiders: cohort(trades, new Set([...dev, ...snipers, ...bundles]), now),
    },
    exhaustion: idle ? null : exhaustion,
    exhaustionBasis: basis,
    liquidityUsd: s.coin.stage === "migrated" ? (q?.liquidityUsd ?? null) : null,
    tapeTrades: trades.length,
    tapeFromLaunch: s.fromLaunch,
  };
}
