"use client";

import Link from "next/link";
import TokenIcon from "./TokenIcon";
import { coinImage, type ActivityItem } from "@/lib/agent";
import { usePolling } from "@/lib/hooks";

const TONE: Record<ActivityItem["tone"], { dot: string; title: string }> = {
  buy: { dot: "bg-emerald-400", title: "text-emerald-300" },
  sell: { dot: "bg-sky-400", title: "text-sky-300" },
  win: { dot: "bg-emerald-400", title: "text-emerald-300" },
  loss: { dot: "bg-rose-400", title: "text-rose-300" },
  setup: { dot: "bg-violet-400", title: "text-violet-300" },
  pass: { dot: "bg-zinc-600", title: "text-zinc-300" },
  analyst: { dot: "bg-amber-400", title: "text-amber-200" },
  system: { dot: "bg-zinc-500", title: "text-zinc-400" },
};

const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** What the agent is doing right now, newest first. */
export default function ActivityFeed({ limit = 60, mint }: { limit?: number; mint?: string }) {
  const { data, error } = usePolling<ActivityItem[]>(`/api/agent/activity?limit=${limit}${mint ? `&mint=${mint}` : ""}`, 3_000);
  const items = data ?? [];
  if (error && !data) return <div className="p-4 text-sm text-zinc-500">{error}</div>;
  if (!data) return <div className="p-4 text-sm text-zinc-500">Loading activity…</div>;
  if (!items.length)
    return <div className="p-4 text-sm text-zinc-500">Nothing yet. The agent logs setups, decisions and trades here as they happen.</div>;
  return (
    <ol className="divide-y divide-zinc-900">
      {items.map((a) => (
        <li key={a.seq} className="flex gap-3 px-4 py-2.5">
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${TONE[a.tone].dot}`} />
          <div className="min-w-0 flex-1 text-sm">
            <div className="flex items-center gap-2">
              {a.mint && !mint && (
                <Link href={`/coin/${a.mint}`} className="flex shrink-0 items-center gap-1.5 font-semibold text-white hover:underline">
                  <TokenIcon src={coinImage(a.mint)} symbol={a.symbol ?? "?"} size={18} />
                  {a.symbol}
                </Link>
              )}
              <span className={`truncate ${TONE[a.tone].title}`}>{a.title}</span>
              <span className="num ml-auto shrink-0 text-xs text-zinc-600">{time(a.ts)}</span>
            </div>
            {a.detail && <div className="mt-0.5 text-xs text-zinc-500">{a.detail}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}
