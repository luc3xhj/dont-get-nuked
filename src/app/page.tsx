"use client";

import { useEffect, useState } from "react";
import FeedRow, { ROW_GRID } from "@/components/FeedRow";
import FilterPanel from "@/components/FilterPanel";
import { BoltIcon, FilterIcon } from "@/components/Icons";
import { applyFilters, countActive, DEFAULT_FILTERS, type Filters } from "@/lib/filters";
import { fmtSol } from "@/lib/format";
import { usePolling, useSolPrice } from "@/lib/hooks";
import type { FeedItem, FeedView, Window } from "@/lib/types";
import { useWallet } from "@/lib/wallet";

const VIEWS: { id: FeedView; label: string; hint: string }[] = [
  { id: "new", label: "New", hint: "Launched in the last hours, screened for traction" },
  { id: "stretch", label: "Final Stretch", hint: "Bonding curve over 50%, close to graduating" },
  { id: "migrated", label: "Migrated", hint: "Graduated to PumpSwap, most active first" },
  { id: "trending", label: "Trending", hint: "Top Solana pools on GeckoTerminal for the timeframe" },
];

const TIMEFRAMES: { id: Window; label: string; tf: string }[] = [
  { id: "m5", label: "5m", tf: "5m" },
  { id: "h1", label: "1h", tf: "1h" },
  { id: "h6", label: "6h", tf: "6h" },
  { id: "h24", label: "24h", tf: "24h" },
];

type SortKey = "default" | "age" | "mcap" | "liq" | "vol" | "txns";
type Sort = { key: SortKey; desc: boolean };

const SETTINGS_KEY = "dgn.discover.v1";
type Settings = { view: FeedView; window: Window; quickBuy: string; filters: Record<FeedView, Filters> };
const DEFAULT_SETTINGS: Settings = { view: "new", window: "h1", quickBuy: "0.25", filters: DEFAULT_FILTERS };

function sortValue(it: FeedItem, key: SortKey, w: Window): number {
  const s = it.windows[w];
  switch (key) {
    case "age":
      return it.createdAt ?? 0;
    case "mcap":
      return it.pair.marketCap;
    case "liq":
      return it.curveProgress !== null ? it.curveProgress * 1e-6 : it.pair.liquidityUsd;
    case "vol":
      return s.volume;
    case "txns":
      return s.buys + s.sells;
    default:
      return 0;
  }
}

export default function Discover() {
  const { state, buy, notify } = useWallet();
  const solUsd = useSolPrice();
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [sort, setSort] = useState<Sort>({ key: "default", desc: true });
  const [, setTick] = useState(0);

  // Restore per-viewer preferences after mount (localStorage is unavailable during SSR).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<Settings>;
        setSettings({ ...DEFAULT_SETTINGS, ...saved, filters: { ...DEFAULT_FILTERS, ...saved.filters } });
      }
    } catch {}
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {}
  }, [settings, loaded]);

  // Re-render every 15s so ages stay current between data refreshes.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 350);
    return () => clearTimeout(t);
  }, [query]);

  const { view, window: w } = settings;
  const tfLabel = TIMEFRAMES.find((t) => t.id === w)!.label;
  const searching = debounced.length > 0;
  const feed = usePolling<FeedItem[]>(loaded ? `/api/feed?view=${view}&tf=${TIMEFRAMES.find((t) => t.id === w)!.tf}` : null, 10_000);
  const search = usePolling<FeedItem[]>(searching ? `/api/search?q=${encodeURIComponent(debounced)}` : null, 30_000);

  const filters = settings.filters[view];
  const source = (searching ? search.data : feed.data) ?? [];
  let rows = searching ? source : applyFilters(source, filters, w);
  if (sort.key !== "default") {
    const dir = sort.desc ? 1 : -1;
    rows = [...rows].sort((a, b) => (sortValue(b, sort.key, w) - sortValue(a, sort.key, w)) * dir);
  }
  const loading = searching ? !search.data && !search.error : !feed.data && !feed.error;
  const error = rows.length ? null : searching ? search.error : feed.error;
  const activeFilters = countActive(filters);
  const quickBuySol = Number(settings.quickBuy) || 0;

  const update = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }));
  const setFilters = (f: Filters) => setSettings((s) => ({ ...s, filters: { ...s.filters, [view]: f } }));

  const quickBuy = (it: FeedItem) => {
    const res = buy(it.pair, solUsd, quickBuySol);
    notify(res.ok, res.ok ? `Bought ${it.pair.symbol} for ${fmtSol(quickBuySol)}` : `${it.pair.symbol}: ${res.error}`);
  };

  // Click: sort descending, again: ascending, third time: back to the view's own order.
  const header = (key: SortKey, label: string, sub?: string) => (
    <button
      onClick={() => setSort((s) => (s.key !== key ? { key, desc: true } : s.desc ? { key, desc: false } : { key: "default", desc: true }))}
      className={`text-left uppercase ${sort.key === key ? "text-white" : "hover:text-white"}`}
    >
      {label}
      {sub && <span className="ml-1 text-zinc-600">{sub}</span>}
      {sort.key === key && (sort.desc ? " ↓" : " ↑")}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="flex items-baseline gap-5">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              title={v.hint}
              onClick={() => {
                update({ view: v.id });
                setQuery("");
                setSort({ key: "default", desc: true });
              }}
              className={`text-lg font-semibold tracking-tight transition-colors ${
                view === v.id && !searching ? "text-white" : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg bg-zinc-900 p-0.5">
            {TIMEFRAMES.map((t) => (
              <button
                key={t.id}
                onClick={() => update({ window: t.id })}
                className={`num rounded-md px-2.5 py-1 text-xs ${w === t.id ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-white"}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => setShowFilters((s) => !s)}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs ${
              showFilters ? "border-zinc-600 text-white" : "border-zinc-800 text-zinc-400 hover:text-white"
            }`}
          >
            <FilterIcon />
            Filters
            {activeFilters > 0 && <span className="num rounded bg-emerald-500/20 px-1 text-emerald-300">{activeFilters}</span>}
          </button>
          <label className="flex items-center gap-1.5 rounded-lg border border-zinc-800 px-2.5 py-1 text-xs text-zinc-400 focus-within:border-zinc-600">
            <BoltIcon className="h-3 w-3 text-emerald-400" />
            Quick buy
            <input
              value={settings.quickBuy}
              onChange={(e) => update({ quickBuy: e.target.value.replace(/[^0-9.]/g, "") })}
              inputMode="decimal"
              className="num w-12 bg-transparent text-right text-white outline-none"
            />
            SOL
          </label>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, symbol or CA…"
            className="w-56 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs outline-none placeholder:text-zinc-600 focus:border-zinc-600"
          />
        </div>
      </div>

      {showFilters && !searching && (
        <FilterPanel
          filters={filters}
          onChange={setFilters}
          onReset={() => setFilters(DEFAULT_FILTERS[view])}
          shown={rows.length}
          total={source.length}
        />
      )}

      {error && <div className="rounded-lg border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-300">Data error: {error}</div>}

      <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950">
        <div className="min-w-[1040px]">
          <div className={`${ROW_GRID} px-4 py-2.5 text-[11px] tracking-wide text-zinc-500`}>
            {header("age", "Pair info")}
            {header("mcap", "Market cap")}
            {header("liq", "Liquidity")}
            {header("vol", "Volume", tfLabel)}
            {header("txns", "Txns", tfLabel)}
            <span className="uppercase">Token info</span>
            <span />
          </div>

          {loading &&
            Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="border-t border-zinc-900 px-4 py-3">
                <div className="h-12 animate-pulse rounded-lg bg-zinc-900" />
              </div>
            ))}

          {!loading && rows.length === 0 && (
            <div className="border-t border-zinc-900 px-4 py-12 text-center text-sm text-zinc-500">
              {searching ? (
                "No Solana pairs match that search."
              ) : (
                <>
                  Nothing passes your filters right now ({source.length} coins checked).{" "}
                  <button onClick={() => setShowFilters(true)} className="underline hover:text-white">
                    Loosen filters
                  </button>
                </>
              )}
            </div>
          )}

          {rows.map((it) => (
            <FeedRow
              key={it.pair.pairAddress}
              item={it}
              window={w}
              quickBuySol={quickBuySol}
              onQuickBuy={quickBuy}
              holding={!!state.positions[it.pair.pairAddress]}
            />
          ))}
        </div>
      </div>

      <p className="text-xs text-zinc-600">
        {VIEWS.find((v) => v.id === view)!.hint}. Data from pump.fun, DexScreener &amp; GeckoTerminal, refreshed every 10s. Trades are
        simulated against real pool and curve reserves — no real funds, no wallet connection.
      </p>
    </div>
  );
}
