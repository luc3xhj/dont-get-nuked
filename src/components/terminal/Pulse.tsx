"use client";

// Pulse: the Axiom-style coin list. Three lifecycle columns, each with Axiom's filter set; only
// coins that pass (or are still being checked) are shown, so junk never reaches the list.
import { useState } from "react";
import TokenIcon from "../TokenIcon";
import { Pill } from "./ui";
import { coinImage, type PulseColumn, type PulseColumnId, type PulseCoin, type PulseFilters, type PulseRangeKey, type PulseReport } from "@/lib/agent";
import { fmtAge, fmtCompact } from "@/lib/format";
import { usePolling } from "@/lib/hooks";

const RANGE_FIELDS: { key: PulseRangeKey; unit?: string; group: "Holders" | "Activity" | "Token" }[] = [
  { key: "top10Holders", unit: "%", group: "Holders" },
  { key: "devHolding", unit: "%", group: "Holders" },
  { key: "snipers", unit: "%", group: "Holders" },
  { key: "insiders", unit: "%", group: "Holders" },
  { key: "bundle", unit: "%", group: "Holders" },
  { key: "holders", group: "Holders" },
  { key: "volume", unit: "$", group: "Activity" },
  { key: "txns", group: "Activity" },
  { key: "numBuys", group: "Activity" },
  { key: "numSells", group: "Activity" },
  { key: "liquidity", unit: "$", group: "Activity" },
  { key: "marketCap", unit: "$", group: "Token" },
  { key: "age", unit: "min", group: "Token" },
  { key: "bondingCurve", unit: "%", group: "Token" },
];

const pct = (v: number | null) => (v === null ? "–" : `${v.toFixed(0)}%`);
const n = (v: number | null) => (v === null ? "–" : v >= 1000 ? fmtCompact(v, "") : String(Math.round(v)));

function MetricCell({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-0.5" title={label}>
      <span className="text-zinc-600">{label}</span>
      <span className={bad ? "text-rose-300" : "text-zinc-300"}>{value}</span>
    </span>
  );
}

function CoinRow({ c, selected, onSelect }: { c: PulseCoin; selected: boolean; onSelect: () => void }) {
  const m = c.metrics;
  return (
    <button
      onClick={onSelect}
      className={`flex w-full items-start gap-2 border-l-2 px-2.5 py-2 text-left transition-colors ${
        selected ? "border-violet-400 bg-panel-2" : "border-transparent hover:bg-panel-2/60"
      }`}
    >
      <TokenIcon src={coinImage(c.mint)} symbol={c.symbol} size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-zinc-100">{c.symbol}</span>
          {c.status === "pass" ? (
            <span className="text-[10px] text-emerald-400" title="Passes every filter">
              ✓
            </span>
          ) : (
            <span className="text-[10px] text-zinc-500" title={`Still checking: ${c.unknown.join(", ")}`}>
              ◌
            </span>
          )}
          {c.hot && (
            <span className="rounded bg-sky-500/15 px-1 text-[9px] font-semibold text-sky-300" title="Deep-watched by the agent">
              LIVE
            </span>
          )}
          <span className="num ml-auto text-[12px] text-zinc-200">{m.marketCap ? fmtCompact(m.marketCap) : "–"}</span>
        </div>
        <div className="num mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10.5px]">
          <span className="text-zinc-500">{fmtAge(c.createdAt)}</span>
          <MetricCell label="H" value={n(m.holders)} />
          <MetricCell label="T10" value={pct(m.top10Holders)} bad={(m.top10Holders ?? 0) > 30} />
          <MetricCell label="Dev" value={pct(m.devHolding)} bad={(m.devHolding ?? 0) > 10} />
          {m.snipers !== null && <MetricCell label="Snp" value={pct(m.snipers)} bad={m.snipers > 10} />}
          <MetricCell label="V" value={m.volume === null ? "–" : fmtCompact(m.volume)} />
          <MetricCell label="TX" value={n(m.txns)} />
          {m.bondingCurve !== null && m.bondingCurve < 100 && <MetricCell label="BC" value={pct(m.bondingCurve)} />}
          {(m.twitter || m.website || m.telegram) && (
            <span className="text-zinc-500">
              {m.twitter ? "𝕏" : ""}
              {m.telegram ? " tg" : ""}
              {m.website ? " web" : ""}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

async function saveFilters(column: PulseColumnId, body: { filters?: PulseFilters; preset?: boolean }) {
  const res = await fetch("/api/agent/pulse", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ column, ...body }) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
}

function FilterEditor({ col, labels, onClose, onSaved }: { col: PulseColumn; labels: Record<string, string>; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<PulseFilters>(col.filters);
  const [error, setError] = useState<string | null>(null);
  const setRange = (k: PulseRangeKey, side: "min" | "max", v: string) => setF({ ...f, [k]: { ...f[k], [side]: v === "" ? null : Number(v) } });
  const input = "num w-full rounded border border-line bg-ink px-1.5 py-1 text-[11px] text-zinc-100 placeholder:text-zinc-700 focus:border-violet-500 focus:outline-none";
  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-panel">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="text-[13px] font-semibold text-zinc-100">{col.label} filters</span>
        <button onClick={onClose} className="text-zinc-500 hover:text-white">
          ✕
        </button>
      </div>
      <div className="scroll-thin flex-1 space-y-3 overflow-y-auto px-3 py-2 text-xs">
        {(["Holders", "Activity", "Token"] as const).map((g) => (
          <div key={g}>
            <div className="label mb-1">{g}</div>
            <div className="space-y-1">
              {RANGE_FIELDS.filter((x) => x.group === g).map(({ key, unit }) => (
                <div key={key} className="grid grid-cols-[1fr_4.5rem_4.5rem] items-center gap-1.5">
                  <span className="text-zinc-400" title={unit ? `In ${unit}` : undefined}>
                    {labels[key] ?? key}
                  </span>
                  <input className={input} placeholder="min" value={f[key].min ?? ""} onChange={(e) => setRange(key, "min", e.target.value)} inputMode="decimal" />
                  <input className={input} placeholder="max" value={f[key].max ?? ""} onChange={(e) => setRange(key, "max", e.target.value)} inputMode="decimal" />
                </div>
              ))}
            </div>
          </div>
        ))}
        <div>
          <div className="label mb-1">Socials &amp; listing</div>
          <div className="flex flex-wrap gap-x-3 gap-y-1.5">
            {(["anySocial", "twitter", "website", "telegram", "dexPaid"] as const).map((k) => (
              <label key={k} className="flex cursor-pointer items-center gap-1.5 text-zinc-300">
                <input type="checkbox" checked={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.checked })} className="accent-violet-500" />
                {k === "anySocial" ? "At least one social" : `Has ${labels[k] ?? k}`}
              </label>
            ))}
          </div>
        </div>
        <div className="grid gap-1.5">
          <div className="label">Keywords (name or ticker, comma separated)</div>
          <input
            className={input}
            placeholder="Only show coins containing…"
            value={f.searchKeywords.join(", ")}
            onChange={(e) => setF({ ...f, searchKeywords: e.target.value.split(",").map((w) => w.trim()).filter(Boolean) })}
          />
          <input
            className={input}
            placeholder="Hide coins containing…"
            value={f.excludeKeywords.join(", ")}
            onChange={(e) => setF({ ...f, excludeKeywords: e.target.value.split(",").map((w) => w.trim()).filter(Boolean) })}
          />
        </div>
        <p className="text-[11px] leading-snug text-zinc-500">
          Snipers and bundle % are measured from the launch tape, so a coin stays &ldquo;checking&rdquo; for those until the agent deep-watches it. Axiom&apos;s
          Pro Traders filter isn&apos;t available for free.
        </p>
        {error && <p className="text-rose-300">{error}</p>}
      </div>
      <div className="flex gap-2 border-t border-line px-3 py-2">
        <button
          onClick={async () => {
            try {
              await saveFilters(col.id, { preset: true });
              onSaved();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
          className="rounded-md border border-line px-2.5 py-1.5 text-xs text-zinc-300 hover:border-zinc-500"
        >
          Reset to preset
        </button>
        <button
          onClick={async () => {
            try {
              await saveFilters(col.id, { filters: f });
              onSaved();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
          className="ml-auto rounded-md bg-violet-500/90 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500"
        >
          Apply
        </button>
      </div>
    </div>
  );
}

export default function Pulse({ selected, onSelect }: { selected: string | null; onSelect: (mint: string) => void }) {
  const [version, setVersion] = useState(0);
  const { data, error } = usePolling<PulseReport>(`/api/agent/pulse?v=${version}`, 4_000);
  const [colId, setColId] = useState<PulseColumnId>("newPairs");
  const [editing, setEditing] = useState(false);
  if (!data) return <div className="p-3 text-xs text-zinc-500">{error ?? "Loading Pulse…"}</div>;
  const col = data.columns.find((c) => c.id === colId)!;
  const hidden = Object.entries(col.failReasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  return (
    <div className="relative flex h-full flex-col">
      <div className="flex border-b border-line">
        {data.columns.map((c) => (
          <button
            key={c.id}
            onClick={() => setColId(c.id)}
            className={`-mb-px flex-1 border-b-2 px-1 py-2 text-center text-[11.5px] ${
              c.id === colId ? "border-violet-400 text-white" : "border-transparent text-zinc-500 hover:text-zinc-200"
            }`}
          >
            {c.label}
            <span className="num ml-1 text-[10px] text-emerald-400/80">{c.counts.pass}</span>
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 border-b border-line px-2.5 py-1.5 text-[10.5px] text-zinc-500">
        <span className="num">
          <span className="text-emerald-400">{col.counts.pass} pass</span> · {col.counts.checking} checking · {col.counts.fail} hidden of {col.counts.seen}
        </span>
        <button onClick={() => setEditing(true)} className="ml-auto rounded border border-line px-2 py-0.5 text-[11px] text-zinc-300 hover:border-violet-500 hover:text-white">
          Filters
        </button>
      </div>
      {hidden.length > 0 && (
        <div className="flex flex-wrap gap-1 border-b border-line px-2.5 py-1.5">
          <span className="text-[10px] text-zinc-600">Hidden by:</span>
          {hidden.map(([k, count]) => (
            <Pill key={k} tone="idle" icon={false}>
              {data.labels[k] ?? k} {count}
            </Pill>
          ))}
        </div>
      )}
      <div className="scroll-thin flex-1 overflow-y-auto">
        {!col.coins.length && <p className="p-3 text-xs text-zinc-500">Nothing passes these filters right now. Loosen them with Filters, or wait for new coins.</p>}
        {col.coins.map((c) => (
          <CoinRow key={c.mint} c={c} selected={selected === c.mint} onSelect={() => onSelect(c.mint)} />
        ))}
      </div>
      {editing && (
        <FilterEditor
          key={col.id}
          col={col}
          labels={data.labels}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setVersion((v) => v + 1);
          }}
        />
      )}
    </div>
  );
}
