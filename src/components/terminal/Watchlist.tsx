"use client";

import { useEffect, useRef, useState } from "react";
import TokenIcon from "../TokenIcon";
import { useTerminal } from "./data";
import Pulse from "./Pulse";
import { coinImage, type WatchedCoin } from "@/lib/agent";
import { fmtAge, fmtCompact } from "@/lib/format";

export type Group = "holding" | "firing" | "armed" | "watching";
export const groupOf = (c: WatchedCoin): Group =>
  c.held ? "holding" : c.setups.some((x) => x.status === "fire") ? "firing" : c.setups.length ? "armed" : "watching";
const ORDER: Group[] = ["holding", "firing", "armed", "watching"];
const GROUP_LABEL: Record<Group, string> = { holding: "Holding", firing: "Setup firing", armed: "Setup armed", watching: "Watching" };
const VERDICT_ORDER = { ok: 0, warn: 1, unknown: 2, veto: 3 };
const LANE = { new: { t: "NEW", c: "text-emerald-400" }, stretch: { t: "FS", c: "text-violet-300" }, migrated: { t: "MIG", c: "text-sky-300" } } as const;

/** Watchlist order: what's closest to a trade first. Shared with keyboard navigation. */
export function orderCoins(coins: WatchedCoin[]) {
  return [...coins].sort(
    (a, b) => ORDER.indexOf(groupOf(a)) - ORDER.indexOf(groupOf(b)) || VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || (b.score ?? 0) - (a.score ?? 0)
  );
}

function Row({ c, selected, onSelect, solUsd }: { c: WatchedCoin; selected: boolean; onSelect: () => void; solUsd: number }) {
  const price = c.quote?.priceSol ?? c.features?.priceSol ?? 0;
  const prev = useRef(price);
  const [flash, setFlash] = useState<{ dir: "up" | "down"; n: number } | null>(null);
  useEffect(() => {
    if (price && prev.current && price !== prev.current) setFlash((f) => ({ dir: price > prev.current ? "up" : "down", n: (f?.n ?? 0) + 1 }));
    prev.current = price;
  }, [price]);

  const vetoes = c.screens.filter((x) => x.level === "veto").length;
  const warns = c.screens.filter((x) => x.level === "warn").length;
  const best = c.setups[0];
  const mcap = c.quote?.mcapUsd ?? (c.features && solUsd ? c.features.mcapSol * solUsd : 0);
  const dd = c.features?.drawdown ?? 0;

  return (
    <button
      onClick={onSelect}
      className={`group flex w-full items-center gap-2 border-l-2 px-2.5 py-1.5 text-left transition-colors ${
        selected ? "border-violet-400 bg-panel-2" : "border-transparent hover:bg-panel-2/60"
      }`}
    >
      <TokenIcon src={coinImage(c.mint)} symbol={c.symbol} size={22} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-zinc-100">{c.symbol}</span>
          {c.lane && <span className={`text-[9px] font-semibold ${LANE[c.lane].c}`}>{LANE[c.lane].t}</span>}
        </div>
        <div className="num flex gap-1.5 text-[10.5px] text-zinc-500">
          <span>{fmtAge(c.createdAt)}</span>
          {best && (
            <span className={best.status === "fire" ? "text-emerald-400" : "text-violet-300"}>
              {best.status === "fire" ? "● fire" : `◌ ${best.trigger.filter((k) => k.ok).length}/${best.trigger.length}`}
            </span>
          )}
          {c.analysis && c.analysis.expiresAt > Date.now() && (
            <span className={c.analysis.verdict === "approve" ? "text-emerald-400" : c.analysis.verdict === "reject" ? "text-rose-400" : "text-zinc-400"}>
              AI {c.analysis.verdict === "approve" ? "✓" : c.analysis.verdict === "reject" ? "✗" : "~"}
            </span>
          )}
        </div>
      </div>
      <div key={flash?.n} className={`num rounded px-1 text-right ${flash ? (flash.dir === "up" ? "flash-up" : "flash-down") : ""}`}>
        <div className="text-[12px] text-zinc-200">{mcap ? fmtCompact(mcap) : "–"}</div>
        <div className={`text-[10.5px] ${dd > 0.4 ? "text-rose-400" : "text-zinc-500"}`}>{c.features ? `−${(dd * 100).toFixed(0)}%` : "…"}</div>
      </div>
      <span
        title={vetoes ? `${vetoes} veto` : warns ? `${warns} warnings` : "Screens clear"}
        className={`dot shrink-0 ${vetoes ? "text-rose-500" : warns ? "text-amber-400" : c.screens.length ? "text-emerald-500" : "text-zinc-700"}`}
        style={{ width: 6, height: 6 }}
      />
    </button>
  );
}

type Mode = "pulse" | "agent";
const MODE_KEY = "dgn.watchlist.mode";

export default function Watchlist({ selected, onSelect }: { selected: string | null; onSelect: (mint: string) => void }) {
  const [mode, setModeState] = useState<Mode>("pulse");
  useEffect(() => {
    try {
      const m = localStorage.getItem(MODE_KEY);
      if (m === "pulse" || m === "agent") setModeState(m);
    } catch {}
  }, []);
  const setMode = (m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {}
  };
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        {(
          [
            ["pulse", "Pulse"],
            ["agent", "Agent watch"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setMode(id)}
            className={`rounded px-2 py-0.5 text-[11.5px] ${mode === id ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-200"}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">{mode === "pulse" ? <Pulse selected={selected} onSelect={onSelect} /> : <AgentWatch selected={selected} onSelect={onSelect} />}</div>
    </div>
  );
}

/** The coins the agent is deep-watching right now, closest to a trade first. */
function AgentWatch({ selected, onSelect }: { selected: string | null; onSelect: (mint: string) => void }) {
  const { state, solUsd } = useTerminal();
  const [showWatching, setShowWatching] = useState(true);
  if (!state) return <div className="p-3 text-xs text-zinc-500">Connecting…</div>;
  const coins = orderCoins(state.hot);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="label">Deep-watched</span>
        <span className="num text-[10.5px] text-zinc-600">
          {state.stats.hot} watched · {state.stats.tracked} tracked
        </span>
      </div>
      <div className="scroll-thin flex-1 overflow-y-auto">
        {ORDER.map((g) => {
          const rows = coins.filter((c) => groupOf(c) === g);
          if (!rows.length) return null;
          const collapsible = g === "watching";
          return (
            <div key={g}>
              <button
                onClick={() => collapsible && setShowWatching((v) => !v)}
                className="sticky top-0 z-10 flex w-full items-center justify-between bg-panel/95 px-3 py-1 text-left backdrop-blur"
              >
                <span className="label">{GROUP_LABEL[g]}</span>
                <span className="num text-[10px] text-zinc-600">
                  {rows.length}
                  {collapsible && (showWatching ? " ▾" : " ▸")}
                </span>
              </button>
              {(!collapsible || showWatching) &&
                rows.map((c) => <Row key={c.mint} c={c} selected={selected === c.mint} onSelect={() => onSelect(c.mint)} solUsd={solUsd} />)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
