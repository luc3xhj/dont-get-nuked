"use client";

import { useEffect, useState } from "react";

export type DockTab = "positions" | "trades" | "decisions" | "research" | "performance" | "evidence" | "dataset";
export type FeedFilter = "all" | "trades" | "decisions" | "setups" | "research";

export type Layout = {
  watchlist: boolean;
  feed: boolean;
  dock: boolean;
  dockTab: DockTab;
  dockTall: boolean;
  follow: boolean;
  feedFilter: FeedFilter;
  /** Focus sections the viewer has expanded. */
  open: string[];
};

const KEY = "dgn.terminal.v1";
const DEFAULTS: Layout = {
  watchlist: true,
  feed: true,
  dock: true,
  dockTab: "positions",
  dockTall: false,
  follow: false,
  feedFilter: "all",
  open: [],
};

/** Panel visibility and preferences, remembered per browser (falls back to defaults if storage is unavailable). */
export function useLayout() {
  const [layout, setLayout] = useState<Layout>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) setLayout({ ...DEFAULTS, ...JSON.parse(raw) });
    } catch {}
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(layout));
    } catch {}
  }, [layout, loaded]);
  const update = (patch: Partial<Layout>) => setLayout((l) => ({ ...l, ...patch }));
  const toggleSection = (id: string) => setLayout((l) => ({ ...l, open: l.open.includes(id) ? l.open.filter((x) => x !== id) : [...l.open, id] }));
  return { layout, update, toggleSection };
}
