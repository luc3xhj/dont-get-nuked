"use client";

import { useEffect, useRef, useState } from "react";
import { useTerminal } from "./data";
import type { FeedFilter } from "./layout";
import type { ActivityItem } from "@/lib/agent";

const TONE: Record<ActivityItem["tone"], { dot: string; title: string; icon: string }> = {
  buy: { dot: "text-emerald-400", title: "text-emerald-300", icon: "▲" },
  sell: { dot: "text-sky-400", title: "text-sky-300", icon: "▼" },
  win: { dot: "text-emerald-400", title: "text-emerald-300", icon: "✓" },
  loss: { dot: "text-rose-400", title: "text-rose-300", icon: "✗" },
  setup: { dot: "text-violet-400", title: "text-violet-300", icon: "◆" },
  pass: { dot: "text-zinc-600", title: "text-zinc-400", icon: "·" },
  analyst: { dot: "text-amber-400", title: "text-amber-200", icon: "✦" },
  system: { dot: "text-zinc-500", title: "text-zinc-400", icon: "•" },
};

const FILTERS: { id: FeedFilter; label: string; tones: ActivityItem["tone"][] | null }[] = [
  { id: "all", label: "All", tones: null },
  { id: "trades", label: "Trades", tones: ["buy", "sell", "win", "loss"] },
  { id: "decisions", label: "Decisions", tones: ["buy", "pass"] },
  { id: "setups", label: "Setups", tones: ["setup"] },
  { id: "research", label: "Research", tones: ["analyst"] },
];

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export default function LiveFeed({
  filter,
  onFilter,
  onSelect,
  selected,
}: {
  filter: FeedFilter;
  onFilter: (f: FeedFilter) => void;
  onSelect: (mint: string) => void;
  selected: string | null;
}) {
  const { activity } = useTerminal();
  const seen = useRef<number | null>(null);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const [hover, setHover] = useState(false);
  const [frozen, setFrozen] = useState<ActivityItem[] | null>(null);

  // Highlight items that arrived since the last poll (not on first load).
  useEffect(() => {
    if (!activity?.length) return;
    const top = activity[0].seq;
    if (seen.current !== null && top > seen.current) setFresh(new Set(activity.filter((a) => a.seq > seen.current!).map((a) => a.seq)));
    seen.current = Math.max(seen.current ?? 0, top);
  }, [activity]);

  // Hovering pauses the stream so the list doesn't move under the pointer.
  useEffect(() => {
    if (hover && !frozen) setFrozen(activity);
    if (!hover) setFrozen(null);
  }, [hover, activity, frozen]);

  const tones = FILTERS.find((f) => f.id === filter)?.tones;
  const items = (frozen ?? activity ?? []).filter((a) => !tones || tones.includes(a.tone));
  const queued = frozen && activity ? activity.filter((a) => a.seq > (frozen[0]?.seq ?? 0)).length : 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="dot text-emerald-500" style={{ width: 6, height: 6 }} />
        <span className="label">Live feed</span>
        {queued > 0 && <span className="num text-[10px] text-violet-300">+{queued} paused</span>}
      </div>
      <div className="flex gap-1 border-b border-line px-2 py-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => onFilter(f.id)}
            className={`rounded px-2 py-0.5 text-[11px] ${filter === f.id ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-200"}`}
          >
            {f.label}
          </button>
        ))}
      </div>
      <ol className="scroll-thin flex-1 overflow-y-auto" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        {!activity && <li className="p-3 text-xs text-zinc-500">Connecting…</li>}
        {activity && !items.length && <li className="p-3 text-xs text-zinc-500">Nothing here yet.</li>}
        {items.map((a) => {
          const t = TONE[a.tone];
          return (
            <li
              key={a.seq}
              onClick={() => a.mint && onSelect(a.mint)}
              className={`border-b border-line/60 px-3 py-2 ${a.mint ? "cursor-pointer hover:bg-panel-2" : ""} ${fresh.has(a.seq) ? "enter" : ""} ${
                a.mint && a.mint === selected ? "bg-violet-500/[0.06]" : ""
              }`}
            >
              <div className="flex items-center gap-2 text-[12px]">
                <span className={`w-3 text-center ${t.dot}`}>{t.icon}</span>
                {a.symbol && <span className="font-semibold text-zinc-100">{a.symbol}</span>}
                <span className={`min-w-0 flex-1 truncate ${t.title}`}>{a.title}</span>
                <span className="num shrink-0 text-[10px] text-zinc-600">{clock(a.ts)}</span>
              </div>
              {a.detail && <div className="ml-5 mt-0.5 line-clamp-2 text-[11px] leading-snug text-zinc-500">{a.detail}</div>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
