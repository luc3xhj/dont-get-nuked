// Human-readable views over the journal: the live activity feed and a coin's trade history.
import { db } from "./db";
import { SETUP_LABEL, type SetupId } from "./setups";
import { coins } from "./state";
import type { Coin } from "./types";

export type ActivityTone = "buy" | "sell" | "win" | "loss" | "setup" | "pass" | "analyst" | "system";
export type ActivityItem = { seq: number; ts: number; mint: string | null; symbol: string | null; tone: ActivityTone; title: string; detail: string };

const KINDS = ["armed", "signal", "decision", "fill", "fill_failed", "order_expired", "close", "analysis", "risk_pause", "control", "start"];
const setupName = (s: string) => SETUP_LABEL[s as SetupId] ?? (s === "random" ? "Random control" : s);
const signed = (v: number, d = 3) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}◎`;

const symbolCache = new Map<string, string>();
export function symbolOf(mint: string | null): string | null {
  if (!mint) return null;
  const live = coins.get(mint)?.coin.symbol;
  if (live) return live;
  if (symbolCache.has(mint)) return symbolCache.get(mint)!;
  const row =
    (db.prepare("SELECT json_extract(data, '$.symbol') AS s FROM coins WHERE mint = ?").get(mint) as { s: string } | undefined) ??
    (db.prepare("SELECT json_extract(data, '$.symbol') AS s FROM closed WHERE json_extract(data, '$.mint') = ? LIMIT 1").get(mint) as
      { s: string } | undefined);
  const sym = row?.s ?? `${mint.slice(0, 4)}…`;
  symbolCache.set(mint, sym);
  return sym;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function describe(kind: string, d: any): Pick<ActivityItem, "tone" | "title" | "detail"> | null {
  const agentOnly = d?.account && d.account !== "agent";
  switch (kind) {
    case "armed":
      return { tone: "setup", title: `Armed · ${setupName(d.setup)}`, detail: `${d.passed}/${d.total} triggers met — waiting for buyers to confirm` };
    case "signal":
      return { tone: "setup", title: `Setup fired · ${setupName(d.setup)}`, detail: "All structure and trigger checks passed" };
    case "decision":
      if (d.take)
        return {
          tone: "buy",
          title: `Decided to buy ${Number(d.sizeSol).toFixed(3)}◎`,
          detail: `${setupName(d.setup)} · ${d.mode === "explore" ? "exploring at reduced size" : `measured edge ${(d.ev * 100).toFixed(1)}%`} · analyst ${d.analyst?.verdict ?? "none"}`,
        };
      return { tone: "pass", title: "Passed", detail: `${setupName(d.setup)} — ${(d.reasons ?? []).join(" · ")}` };
    case "fill":
      if (agentOnly) return null;
      return d.side === "buy"
        ? {
            tone: "buy",
            title: `Bought for ${Number(d.sol).toFixed(3)}◎`,
            detail: `Filled after latency, ${((d.impact ?? 0) * 100).toFixed(2)}% price impact`,
          }
        : { tone: "sell", title: `Sold for ${Number(d.sol).toFixed(3)}◎`, detail: d.reason ?? "" };
    case "fill_failed":
      if (agentOnly) return null;
      return { tone: "pass", title: `${d.side === "buy" ? "Buy" : "Sell"} failed`, detail: d.reason ?? "" };
    case "order_expired":
      if (agentOnly) return null;
      return { tone: "pass", title: "Order expired", detail: "No fresh quote arrived in time" };
    case "close":
      if (agentOnly) return null;
      return {
        tone: d.pnlSol >= 0 ? "win" : "loss",
        title: `Closed ${signed(d.pnlSol)} (${d.pnlPct >= 0 ? "+" : ""}${(d.pnlPct * 100).toFixed(1)}%, ${d.r.toFixed(2)}R)`,
        detail: `${d.exitReason} · held ${d.holdMin.toFixed(1)}m · ${setupName(d.setup)}`,
      };
    case "analysis": {
      const a = d.analysis;
      return { tone: "analyst", title: `Analyst: ${a.verdict} ×${Number(a.conviction).toFixed(2)}`, detail: `${a.narrativeType} — ${a.narrative}` };
    }
    case "risk_pause":
      return agentOnly ? null : { tone: "system", title: "Risk pause", detail: d.reason };
    case "control":
      return { tone: "system", title: d.action === "pause" ? "Paused by you" : "Resumed by you", detail: "" };
    case "start":
      return { tone: "system", title: "Agent started", detail: "Restored wallet, positions and history" };
  }
  return null;
}

export function activity(limit = 60, beforeSeq?: number, mint?: string): ActivityItem[] {
  const rows = db
    .prepare(`SELECT seq, ts, mint, kind, data FROM journal WHERE kind IN (${KINDS.map(() => "?").join(",")}) AND seq < ?${mint ? " AND mint = ?" : ""} ORDER BY seq DESC LIMIT ?`)
    .all(...KINDS, beforeSeq ?? Number.MAX_SAFE_INTEGER, ...(mint ? [mint] : []), limit * 4) as { seq: number; ts: number; mint: string | null; kind: string; data: string }[];
  const out: ActivityItem[] = [];
  for (const r of rows) {
    const d = describe(r.kind, JSON.parse(r.data));
    if (!d) continue;
    out.push({ seq: r.seq, ts: r.ts, mint: r.mint, symbol: symbolOf(r.mint), ...d });
    if (out.length >= limit) break;
  }
  return out;
}

/** The agent's own buys and sells on a coin, for chart markers and the coin page. */
export function agentFills(mint: string) {
  return (db.prepare("SELECT ts, data FROM journal WHERE mint = ? AND kind = 'fill' ORDER BY seq").all(mint) as { ts: number; data: string }[])
    .map((r) => ({ ts: r.ts, ...(JSON.parse(r.data) as { account: string; side: "buy" | "sell"; sol: number; priceSol: number; reason?: string }) }))
    .filter((f) => f.account === "agent");
}

export function storedCoin(mint: string): Coin | null {
  const row = db.prepare("SELECT data FROM coins WHERE mint = ?").get(mint) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as Coin) : null;
}
