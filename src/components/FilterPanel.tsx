"use client";

import type { Filters } from "@/lib/filters";

type NumKey = "maxAgeMin" | "minMcap" | "maxMcap" | "minLiquidity" | "minVolume" | "minTxns" | "minBuyPct";
type BoolKey = "needAnySocial" | "needTwitter" | "needTelegram" | "needWebsite";

const NUMS: { key: NumKey; label: string; suffix: string; hint?: string }[] = [
  { key: "maxAgeMin", label: "Max age", suffix: "min" },
  { key: "minMcap", label: "Min market cap", suffix: "$" },
  { key: "maxMcap", label: "Max market cap", suffix: "$" },
  { key: "minLiquidity", label: "Min liquidity", suffix: "$", hint: "Pools only" },
  { key: "minVolume", label: "Min volume", suffix: "$", hint: "In timeframe" },
  { key: "minTxns", label: "Min txns", suffix: "#", hint: "In timeframe" },
  { key: "minBuyPct", label: "Min buys", suffix: "%", hint: "Share of txns" },
];

const BOOLS: { key: BoolKey; label: string }[] = [
  { key: "needAnySocial", label: "Has any social" },
  { key: "needTwitter", label: "Has X" },
  { key: "needTelegram", label: "Has Telegram" },
  { key: "needWebsite", label: "Has website" },
];

export default function FilterPanel({
  filters,
  onChange,
  onReset,
  shown,
  total,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  onReset: () => void;
  shown: number;
  total: number;
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {NUMS.map(({ key, label, suffix, hint }) => (
          <label key={key} className="space-y-1">
            <span className="flex justify-between text-[11px] uppercase text-zinc-500">
              {label}
              {hint && <span className="normal-case text-zinc-600">{hint}</span>}
            </span>
            <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-900 focus-within:border-zinc-600">
              <input
                value={filters[key] ?? ""}
                placeholder="Any"
                inputMode="decimal"
                onChange={(e) => {
                  const v = e.target.value.replace(/[^0-9.]/g, "");
                  onChange({ ...filters, [key]: v === "" ? null : Number(v) });
                }}
                className="num w-full min-w-0 bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-zinc-600"
              />
              <span className="pr-2.5 text-xs text-zinc-600">{suffix}</span>
            </div>
          </label>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {BOOLS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => onChange({ ...filters, [key]: !filters[key] })}
            className={`rounded-full border px-3 py-1 text-xs ${
              filters[key] ? "border-emerald-500 bg-emerald-500/10 text-emerald-300" : "border-zinc-800 text-zinc-400 hover:text-white"
            }`}
          >
            {label}
          </button>
        ))}
        <span className="ml-auto text-xs text-zinc-500">
          Showing <span className="num text-zinc-300">{shown}</span> of <span className="num">{total}</span>
        </span>
        <button onClick={onReset} className="rounded-md bg-zinc-800 px-3 py-1 text-xs hover:bg-zinc-700">
          Reset to defaults
        </button>
      </div>
    </div>
  );
}
