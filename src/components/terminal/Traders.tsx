"use client";

// Traders: wallets the user watches, and wallets our own tape history ranks well. Their trades are shown
// on coins as evidence; the agent never copies them.
import { useState } from "react";
import { Chip, Metric, Pill, type Tone } from "./ui";
import { shortAddr, type TraderOnCoin, type TradersReport } from "@/lib/agent";
import { fmtAge, fmtCompact } from "@/lib/format";
import { usePolling } from "@/lib/hooks";

const signedSol = (v: number, d = 3) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}◎`;
const pnlTone = (v: number | null): Tone | undefined => (v === null ? undefined : v >= 0 ? "ok" : "bad");

export function TraderAvatar({ name, address, source, size = 32 }: { name: string | null; address: string; source: "watching" | "discovered"; size?: number }) {
  const initials = (name ?? address).replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase();
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ring-2 ${
        source === "watching" ? "bg-amber-500/15 text-amber-200 ring-amber-500/60" : "bg-sky-500/15 text-sky-200 ring-sky-500/50"
      }`}
      style={{ width: size, height: size, fontSize: size * 0.36 }}
    >
      {initials}
    </span>
  );
}

const sourcePill = (s: "watching" | "discovered") => (
  <Pill tone={s === "watching" ? "warn" : "live"} icon={false}>
    {s === "watching" ? "Watching" : "Discovered"}
  </Pill>
);

/** One trader's position in the focused coin (entry, multiple since, still holding, P&L). */
export function TraderCard({ t }: { t: TraderOnCoin }) {
  return (
    <div className="rounded-lg border border-line bg-panel-2/40 p-3 text-xs">
      <div className="flex items-center gap-2.5">
        <TraderAvatar name={t.name} address={t.address} source={t.source} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-zinc-100">{t.name ?? shortAddr(t.address)}</span>
            {sourcePill(t.source)}
          </div>
          <div className="truncate text-zinc-500">
            {t.xHandle ? (
              <a href={`https://x.com/${t.xHandle}`} target="_blank" rel="noreferrer noopener" className="hover:text-zinc-200">
                @{t.xHandle}
              </a>
            ) : (
              shortAddr(t.address)
            )}{" "}
            · last {t.lastAction} {fmtAge(t.lastActionAt)} ago
          </div>
        </div>
      </div>
      <div className="mt-2.5 grid grid-cols-2 gap-1.5">
        <Metric label="Entered at" value={t.entryMcapUsd ? fmtCompact(t.entryMcapUsd) : "–"} hint={`First buy ${fmtAge(t.firstBuyAt)} ago`} />
        <Metric label="Since entry" value={t.multiple ? `${t.multiple.toFixed(2)}x` : "–"} tone={t.multiple ? (t.multiple >= 1 ? "ok" : "bad") : undefined} />
        <Metric label="Still holding" value={`${t.holdingPct.toFixed(0)}%`} tone={t.holdingPct < 5 ? "idle" : undefined} />
        <Metric label="P&L" value={t.pnlSol === null ? "–" : signedSol(t.pnlSol)} tone={pnlTone(t.pnlSol)} hint={`In ${t.solIn.toFixed(3)}◎ · out ${t.solOut.toFixed(3)}◎`} />
      </div>
      {!t.complete && <p className="mt-1.5 text-[11px] text-amber-300/80">Tape is partial: some of this wallet&apos;s trades may be missing.</p>}
    </div>
  );
}

async function post(body: Record<string, unknown>) {
  const res = await fetch("/api/agent/traders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json;
}

function WatchForm({ onDone, initial }: { onDone: () => void; initial?: string }) {
  const [address, setAddress] = useState(initial ?? "");
  const [name, setName] = useState("");
  const [xHandle, setXHandle] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = "w-full rounded-md border border-line bg-ink px-2 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-violet-500 focus:outline-none";
  return (
    <form
      className="grid gap-1.5 rounded-lg border border-line bg-panel-2/40 p-2.5 sm:grid-cols-[2fr_1fr_1fr_auto]"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await post({ address, name, xHandle, note });
          setAddress("");
          setName("");
          setXHandle("");
          setNote("");
          onDone();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <input className={`${input} num`} placeholder="Wallet address" value={address} onChange={(e) => setAddress(e.target.value)} required />
      <input className={input} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <input className={input} placeholder="@handle (optional)" value={xHandle} onChange={(e) => setXHandle(e.target.value)} />
      <button disabled={busy} className="rounded-md bg-violet-500/90 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50">
        {busy ? "Adding…" : "Watch"}
      </button>
      <input className={`${input} sm:col-span-4`} placeholder="Why you're watching them (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      {error && <p className="text-xs text-rose-300 sm:col-span-4">{error}</p>}
    </form>
  );
}

export function TradersTab({ onSelect }: { onSelect: (mint: string) => void }) {
  const [version, setVersion] = useState(0);
  const { data, error } = usePolling<TradersReport>(`/api/agent/traders?v=${version}`, 15_000);
  const refresh = () => setVersion((v) => v + 1);
  if (!data) return <div className="p-4 text-xs text-zinc-500">{error ?? "Loading traders…"}</div>;
  return (
    <div className="grid items-start gap-4 p-3 lg:grid-cols-2">
      <section className="space-y-2">
        <div className="flex items-baseline gap-2">
          <span className="label">Watching</span>
          <span className="text-[11px] text-zinc-500">Wallets you add. Their trades show on charts, coin pages and the live feed.</span>
        </div>
        <WatchForm onDone={refresh} />
        {!data.watching.length && <p className="text-xs text-zinc-500">No wallets yet. Add one above, or watch a discovered wallet.</p>}
        {data.watching.map((w) => (
          <div key={w.address} className="flex items-start gap-2.5 rounded-lg border border-line bg-panel p-2.5 text-xs">
            <TraderAvatar name={w.name} address={w.address} source="watching" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-semibold text-zinc-100">{w.name}</span>
                {w.xHandle && (
                  <a href={`https://x.com/${w.xHandle}`} target="_blank" rel="noreferrer noopener" className="text-zinc-400 hover:text-zinc-100">
                    @{w.xHandle}
                  </a>
                )}
                <button onClick={() => navigator.clipboard.writeText(w.address)} className="num text-zinc-600 hover:text-zinc-300" title="Copy address">
                  {shortAddr(w.address)}
                </button>
              </div>
              {w.note && <p className="mt-0.5 text-zinc-400">{w.note}</p>}
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <Chip label="coins seen" value={w.coinsSeen} />
                <Chip label="last active" value={w.lastActiveAt ? `${fmtAge(w.lastActiveAt)} ago` : "not seen yet"} tone={w.lastActiveAt ? undefined : "idle"} />
                {w.discovered && <Chip label="our data" value={`${w.discovered.wins}/${w.discovered.closed} closed in profit`} tone="ok" />}
                {w.lastMint && (
                  <button onClick={() => onSelect(w.lastMint!)} className="text-[11px] text-violet-300 hover:underline">
                    open last coin ↗
                  </button>
                )}
              </div>
            </div>
            <button
              onClick={async () => {
                await post({ action: "remove", address: w.address }).catch(() => {});
                refresh();
              }}
              className="text-[11px] text-zinc-500 hover:text-rose-300"
            >
              Remove
            </button>
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <div className="flex items-baseline gap-2">
          <span className="label">Discovered</span>
          <span className="text-[11px] text-zinc-500">
            Ranked from trades we recorded: coins they bought and sold in full, scored by a cautious win rate (≥ {data.discovery.minClosed} closed). Bots, snipers and seconds-long flippers excluded.
          </span>
        </div>
        {!data.discovered.length && <p className="text-xs text-zinc-500">Not enough completed trades recorded yet. The ranking refreshes every 10 minutes.</p>}
        {data.discovered.length > 0 && (
          <table className="w-full text-xs">
            <thead className="text-[10px] uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-2 py-1 text-left font-normal">Wallet</th>
                <th className="px-2 py-1 text-right font-normal" title="Coins bought and fully sold that we saw completely">
                  Closed
                </th>
                <th className="px-2 py-1 text-right font-normal" title="Cautious (95%) lower bound on the share closed in profit">
                  Win rate ≥
                </th>
                <th className="px-2 py-1 text-right font-normal">Realized</th>
                <th className="px-2 py-1 text-right font-normal" title="Realized profit ÷ SOL spent on closed coins">
                  Return
                </th>
                <th className="px-2 py-1 text-right font-normal" title="Average time from first buy to exit">
                  Hold
                </th>
                <th className="px-2 py-1 text-right font-normal">Active</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.discovered.map((d, i) => (
                <tr key={d.address} className="border-t border-line">
                  <td className="px-2 py-1.5">
                    <span className="num mr-2 text-zinc-600">{i + 1}</span>
                    <button onClick={() => navigator.clipboard.writeText(d.address)} className="num text-zinc-200 hover:text-white" title="Copy address">
                      {shortAddr(d.address)}
                    </button>
                  </td>
                  <td className="num px-2 py-1.5 text-right text-zinc-300">
                    {d.wins}/{d.closed}
                  </td>
                  <td className="num px-2 py-1.5 text-right text-emerald-300">{(d.winRateLower * 100).toFixed(0)}%</td>
                  <td className={`num px-2 py-1.5 text-right ${d.realizedSol >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{signedSol(d.realizedSol, 2)}</td>
                  <td className="num px-2 py-1.5 text-right text-zinc-300">{d.returnOnCost != null ? `${(d.returnOnCost * 100).toFixed(0)}%` : "–"}</td>
                  <td className="num px-2 py-1.5 text-right text-zinc-500">{d.avgHoldMin != null ? `${d.avgHoldMin.toFixed(0)}m` : "–"}</td>
                  <td className="num px-2 py-1.5 text-right text-zinc-500">{fmtAge(d.lastActiveAt)}</td>
                  <td className="px-2 py-1.5 text-right">
                    {d.watching ? (
                      <Pill tone="warn" icon={false}>
                        Watching
                      </Pill>
                    ) : (
                      <button
                        onClick={async () => {
                          await post({ address: d.address }).catch(() => {});
                          refresh();
                        }}
                        className="rounded-md border border-line px-2 py-0.5 text-[11px] text-zinc-300 hover:border-violet-500 hover:text-white"
                      >
                        Watch
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
