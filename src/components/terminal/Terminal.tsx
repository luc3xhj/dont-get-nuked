"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { TerminalDataProvider, useTerminal } from "./data";
import Dock from "./Dock";
import FocusView from "./FocusView";
import { useLayout, type DockTab } from "./layout";
import LiveFeed from "./LiveFeed";
import TopBar from "./TopBar";
import Watchlist, { orderCoins } from "./Watchlist";

const SHORTCUTS: [string, string][] = [
  ["J / K", "Next / previous coin"],
  ["F", "Follow the agent (focus jumps to what it acts on)"],
  ["W", "Show / hide watchlist"],
  ["L", "Show / hide live feed"],
  ["D", "Show / hide dock"],
  ["1–7", "Dock tabs"],
  ["?", "This help"],
];
const DOCK_KEYS: DockTab[] = ["positions", "trades", "decisions", "research", "performance", "evidence", "dataset"];
const FOLLOWED = new Set(["buy", "sell", "win", "loss", "setup", "analyst"]);

function Shell() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { state, portfolio, activity, error } = useTerminal();
  const { layout, update, toggleSection } = useLayout();
  const [help, setHelp] = useState(false);
  const selected = params.get("coin");
  const followSeq = useRef<number | null>(null);

  const select = (mint: string) => {
    if (mint === selected) return;
    const q = new URLSearchParams(params.toString());
    q.set("coin", mint);
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  };

  // Deep links from the old pages: ?dock=research etc.
  useEffect(() => {
    const dock = params.get("dock") as DockTab | null;
    if (dock && DOCK_KEYS.includes(dock)) update({ dock: true, dockTab: dock });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Default focus: a held coin, else a firing setup, else the top of the watchlist.
  useEffect(() => {
    if (selected || !state?.hot.length) return;
    const held = portfolio?.open.find((p) => p.account === "agent")?.mint;
    select(held ?? orderCoins(state.hot)[0].mint);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, state, portfolio]);

  // Follow mode: jump to the coin behind each new agent action.
  useEffect(() => {
    if (!activity?.length) return;
    const newest = activity[0].seq;
    if (followSeq.current === null) {
      followSeq.current = newest;
      return;
    }
    if (layout.follow) {
      const next = activity.find((a) => a.seq > followSeq.current! && a.mint && FOLLOWED.has(a.tone));
      if (next?.mint) select(next.mint);
    }
    followSeq.current = newest;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity, layout.follow]);

  // Keyboard shortcuts (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      const k = e.key.toLowerCase();
      if (k === "j" || k === "k") {
        const list = orderCoins(state?.hot ?? []);
        if (!list.length) return;
        const i = list.findIndex((c) => c.mint === selected);
        select(list[(i + (k === "j" ? 1 : -1) + list.length) % list.length].mint);
      } else if (k === "f") update({ follow: !layout.follow });
      else if (k === "w") update({ watchlist: !layout.watchlist });
      else if (k === "l") update({ feed: !layout.feed });
      else if (k === "d") update({ dock: !layout.dock });
      else if (k === "?") setHelp((h) => !h);
      else if (k === "escape") setHelp(false);
      else if (/^[1-7]$/.test(k)) update({ dock: true, dockTab: DOCK_KEYS[Number(k) - 1] });
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const cols = [layout.watchlist ? "264px" : null, "minmax(0,1fr)", layout.feed ? "340px" : null].filter(Boolean).join(" ");

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <TopBar layout={layout} update={update} onHelp={() => setHelp(true)} />
      {error && (
        <div role="alert" className="border-b border-rose-900 bg-rose-950/40 px-3 py-1.5 text-xs text-rose-300">
          Agent worker unreachable: {error}. Start it with <code>npm run agent:start</code>.
        </div>
      )}
      <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: cols }}>
        {layout.watchlist && (
          <aside className="min-h-0 border-r border-line bg-panel">
            <Watchlist selected={selected} onSelect={select} />
          </aside>
        )}
        <main className="scroll-thin min-h-0 overflow-y-auto">
          <FocusView mint={selected} open={layout.open} onToggle={toggleSection} />
        </main>
        {layout.feed && (
          <aside className="min-h-0 border-l border-line bg-panel">
            <LiveFeed filter={layout.feedFilter} onFilter={(feedFilter) => update({ feedFilter })} onSelect={select} selected={selected} />
          </aside>
        )}
      </div>
      {layout.dock ? (
        <div className={`shrink-0 border-t border-line bg-panel ${layout.dockTall ? "h-[48vh]" : "h-[260px]"}`}>
          <Dock layout={layout} update={update} onSelect={select} />
        </div>
      ) : (
        <button onClick={() => update({ dock: true })} className="shrink-0 border-t border-line bg-panel px-3 py-1 text-left text-[11px] text-zinc-500 hover:text-zinc-200">
          ▴ Dock: positions, trades, decisions, research audit, performance (D)
        </button>
      )}

      {help && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setHelp(false)}>
          <div className="w-[380px] rounded-xl border border-line-2 bg-panel p-5" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <span className="font-semibold">Keyboard shortcuts</span>
              <button onClick={() => setHelp(false)} className="text-zinc-500 hover:text-white">
                ✕
              </button>
            </div>
            <dl className="space-y-1.5 text-sm">
              {SHORTCUTS.map(([k, v]) => (
                <div key={k} className="flex gap-3">
                  <dt className="num w-14 shrink-0 text-violet-300">{k}</dt>
                  <dd className="text-zinc-300">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 text-xs text-zinc-500">
              Click any pipeline step to open its detail. Panels, open sections and the dock tab are remembered in this browser.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Terminal() {
  return (
    <TerminalDataProvider>
      <Shell />
    </TerminalDataProvider>
  );
}
