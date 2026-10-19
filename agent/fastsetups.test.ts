import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoinState } from "./state";
import type { Trade } from "./types";

process.env.AGENT_DB = ":memory:";

const T0 = 1_800_000_000_000;
let slot = 0;
function trade(ts: number, priceSol: number, side: "buy" | "sell" = "buy", sol = 0.3, wallet?: string): Trade {
  slot++;
  return {
    id: String(slot).padStart(12, "0"),
    tx: `tx${slot}`,
    mint: "F".repeat(32),
    ts,
    slot,
    wallet: wallet ?? `w${slot}`,
    side,
    sol,
    tokens: sol / priceSol,
    priceSol,
    program: "pump",
  } as Trade;
}

/** Launch tape: smooth impulse 1e-7 → 2e-7 over 5 min, pullback to `low` over 2 min, then a reclaim. */
function tape(opts: { earlierDip?: boolean; secondPullback?: boolean; low?: number } = {}) {
  const out: Trade[] = [];
  let t = T0;
  for (let i = 0; i <= 50; i++) {
    let p = 1e-7 * (1 + i / 50);
    if (opts.earlierDip && i === 25) p *= 0.8; // a 20% dip on the way up
    out.push(trade((t += 6_000), p));
  }
  const peak = 2e-7;
  const low = opts.low ?? 1.6e-7;
  for (let i = 1; i <= 20; i++) out.push(trade((t += 6_000), peak - ((peak - low) * i) / 20, "sell"));
  if (opts.secondPullback) {
    out.push(trade((t += 6_000), 1.9e-7));
    out.push(trade((t += 6_000), 1.65e-7, "sell"));
  }
  // Reclaim: many distinct buyers in the last minute.
  for (let i = 0; i < 8; i++) out.push(trade((t += 5_000), 1.82e-7 + i * 1e-9));
  return { trades: out, now: t + 1_000 };
}

async function evalCoin(trades: Trade[], now: number, extra: Partial<CoinState> = {}, coinExtra: Record<string, unknown> = {}) {
  const { computeFeatures } = await import("./features");
  const { evaluateSetups } = await import("./setups");
  const s = {
    coin: { mint: "F".repeat(32), name: "Fast", symbol: "FST", creator: "c", curve: "curve", pool: null, stage: "curve", createdAt: T0, socials: { twitter: null, website: null, telegram: null }, replies: 0, mcapUsd: 30_000, athMcapUsd: 40_000, curveProgress: 0.3, lastTradeAt: now, firstSeen: T0, updatedAt: now, ...coinExtra },
    quote: null, hot: true, hotSince: T0, score: 1, trades, ids: new Set(trades.map((x) => x.tx)), fromLaunch: true, backfilling: false, backfilled: true, nextPollAt: 0, tapeGaps: 0,
    lastPolledAt: now - 2_000, holders: null, social: null, dev: null, funding: null, features: null, screens: [], setups: [], analysis: null,
    ...extra,
  } as unknown as CoinState;
  s.features = computeFeatures(s, now);
  const dev = { coins: 0, resolved: 0, successes: 0, successRate: 0, lowerBound: 0, proven: false, source: "observed" as const };
  return evaluateSetups(s, dev);
}

test("first shallow pullback fires on a clean sequence and carries its TTL", async () => {
  const { trades, now } = tape();
  const ev = (await evalCoin(trades, now)).find((x) => x.setup === "first_shallow_pullback");
  assert.ok(ev, "the setup's structure formed");
  const failing = [...ev.structure, ...ev.trigger].filter((k) => !k.ok).map((k) => `${k.label}: ${k.value}`);
  assert.equal(ev.status, "fire", failing.join("; "));
  assert.equal(ev.plan!.entryTtlMs, 20_000);
  assert.ok(ev.plan!.stopSol < 1.6e-7 && ev.plan!.tp1Sol > ev.plan!.entrySol);
});

test("an earlier dip or a second pullback is never relabelled the first pullback", async () => {
  const dip = tape({ earlierDip: true });
  assert.equal((await evalCoin(dip.trades, dip.now)).find((x) => x.setup === "first_shallow_pullback"), undefined);
  const second = tape({ secondPullback: true });
  assert.equal((await evalCoin(second.trades, second.now)).find((x) => x.setup === "first_shallow_pullback"), undefined);
});

test("a stale tape keeps fast strategies from forming (contract readiness)", async () => {
  const { trades, now } = tape();
  const ev = (await evalCoin(trades, now, { lastPolledAt: now - 60_000 } as Partial<CoinState>)).find((x) => x.setup === "first_shallow_pullback");
  assert.equal(ev, undefined, "tape older than 20s fails the contract");
  const partial = (await evalCoin(trades, now, { fromLaunch: false } as Partial<CoinState>)).find((x) => x.setup === "first_shallow_pullback");
  assert.equal(partial, undefined, "a partial tape can't establish 'first since launch'");
});

test("migration response requires a verified migration time", async () => {
  const { trades, now } = tape();
  const migratedAt = now - 2 * 60_000;
  const base = { stage: "migrated", curveProgress: 1, pool: "pool" };
  const observed = (await evalCoin(trades, now, {}, { ...base, migratedAt, migratedAtSource: "observed" })).find((x) => x.setup === "migration_event");
  assert.equal(observed, undefined, "a list-poll observation time is not a verified migration time");
  const streamed = await evalCoin(trades, now, { quote: { at: now, priceSol: 1.89e-7, priceUsd: 2.8e-5, liquidityUsd: 20_000, mcapUsd: 30_000, reserveTokens: 1, reserveSol: 1 } } as Partial<CoinState>, { ...base, migratedAt, migratedAtSource: "migration_stream" });
  const ev = streamed.find((x) => x.setup === "migration_event");
  assert.ok(ev, "structure forms with a stream-verified migration time");
  assert.ok(ev.structure.find((k) => k.label.startsWith("Migration time verified"))!.ok);
});
