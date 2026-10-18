"use client";

import { useTerminal } from "./data";
import type { Layout } from "./layout";
import { pctSigned, solSigned } from "@/lib/agent";
import { fmtCompact, pnlColor } from "@/lib/format";

function Chip({ tone, label, value, title }: { tone: "ok" | "warn" | "bad" | "info" | "idle"; label: string; value: string; title?: string }) {
  const color = { ok: "text-emerald-400", warn: "text-amber-400", bad: "text-rose-400", info: "text-violet-400", idle: "text-zinc-500" }[tone];
  return (
    <span title={title} className="flex items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-1 text-[11px]">
      <span className={`dot ${color}`} style={{ width: 6, height: 6 }} />
      <span className="text-zinc-500">{label}</span>
      <span className="text-zinc-200">{value}</span>
    </span>
  );
}

function Toggle({ on, onClick, children, title }: { on: boolean; onClick: () => void; children: React.ReactNode; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className={`rounded-md px-2 py-1 text-[11px] transition-colors ${on ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-200"}`}
    >
      {children}
    </button>
  );
}

export default function TopBar({ layout, update, onHelp }: { layout: Layout; update: (p: Partial<Layout>) => void; onHelp: () => void }) {
  const { state, portfolio, solUsd, error } = useTerminal();
  const agent = portfolio?.accounts.find((a) => a.id === "agent");
  const pnl = agent ? agent.equity - agent.startCash : 0;
  const dayStart = agent?.curve.find(([t]) => t >= new Date().setUTCHours(0, 0, 0, 0))?.[1];
  const today = agent && dayStart !== undefined ? agent.equity - dayStart : 0;
  const open = portfolio?.open.filter((p) => p.account === "agent").length ?? 0;
  const status = error ? "offline" : !agent ? "connecting" : agent.paused ? "paused" : agent.cooldownUntil > Date.now() ? "cooling down" : "trading";
  const regime = state?.regime;
  const analyst = state?.analyst;
  const treg = state?.treg;
  const control = (action: "pause" | "resume") => fetch(`/api/agent/control?action=${action}`, { method: "POST" });

  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-panel px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-lg">☢️</span>
        <span className="font-semibold tracking-tight">Don&apos;t Get Nuked</span>
        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-400">paper</span>
      </div>

      <div className="flex items-baseline gap-3 border-l border-line pl-4">
        <div>
          <div className="label">Agent wallet</div>
          <div className="num text-[15px] font-semibold text-white">
            {agent ? `${agent.equity.toFixed(3)} SOL` : "…"}
            {agent && solUsd > 0 && <span className="ml-1.5 text-xs font-normal text-zinc-500">{fmtCompact(agent.equity * solUsd)}</span>}
          </div>
        </div>
        {agent && (
          <div className="num text-xs leading-tight">
            <div className={pnlColor(pnl)}>
              {solSigned(pnl)} <span className="opacity-70">({pctSigned(pnl / agent.startCash, 2)})</span>
            </div>
            <div className={`${pnlColor(today)} opacity-80`}>{solSigned(today)} today</div>
          </div>
        )}
        <span className="num text-xs text-zinc-500">{open} open</span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Chip
          tone={status === "trading" ? "ok" : status === "offline" ? "bad" : "warn"}
          label="Agent"
          value={status}
          title={agent?.paused ?? error ?? "Trading autonomously"}
        />
        {regime && (
          <Chip
            tone={regime.level === "good" ? "ok" : regime.level === "caution" ? "warn" : "bad"}
            label="Regime"
            value={regime.level === "good" ? "good · full size" : regime.level === "caution" ? "caution · half size" : "bad · no entries"}
            title={regime.reasons.join("; ")}
          />
        )}
        {analyst && (
          <Chip
            tone={analyst.running ? "info" : ["not-installed", "not-logged-in", "error"].includes(analyst.status) ? "warn" : "idle"}
            label="Codex"
            value={analyst.running ? `researching ${analyst.running}` : `${analyst.status} · ${analyst.callsLastHour}/${analyst.maxPerHour}h`}
            title={analyst.lastError ?? undefined}
          />
        )}
        {treg && (
          <Chip
            tone={treg.disabled || treg.lastError ? "warn" : treg.configured ? "ok" : "idle"}
            label="Treg"
            value={treg.disabled ? "disabled" : treg.lastError ? "search error" : treg.configured ? `free search · ${treg.calls}` : "off"}
            title={treg.disabled ?? treg.lastError ?? "Free TinyFish search, $0 cap"}
          />
        )}
      </div>

      <div className="ml-auto flex items-center gap-1">
        <Toggle on={layout.follow} onClick={() => update({ follow: !layout.follow })} title="Follow the agent: focus jumps to whatever it acts on (F)">
          ◎ Follow
        </Toggle>
        <span className="mx-1 h-4 w-px bg-line" />
        <Toggle on={layout.watchlist} onClick={() => update({ watchlist: !layout.watchlist })} title="Watchlist (W)">
          Watchlist
        </Toggle>
        <Toggle on={layout.feed} onClick={() => update({ feed: !layout.feed })} title="Live feed (L)">
          Feed
        </Toggle>
        <Toggle on={layout.dock} onClick={() => update({ dock: !layout.dock })} title="Bottom dock (D)">
          Dock
        </Toggle>
        <button onClick={onHelp} title="Keyboard shortcuts (?)" className="rounded-md px-2 py-1 text-[11px] text-zinc-500 hover:text-zinc-200">
          ?
        </button>
        <span className="mx-1 h-4 w-px bg-line" />
        {agent?.paused ? (
          <button onClick={() => control("resume")} className="rounded-md bg-emerald-500 px-2.5 py-1 text-[11px] font-semibold text-black hover:bg-emerald-400">
            Resume
          </button>
        ) : (
          <button onClick={() => control("pause")} className="rounded-md border border-line-2 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800">
            Pause entries
          </button>
        )}
      </div>
    </header>
  );
}
