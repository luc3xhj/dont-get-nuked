"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { fmtCompact, pnlColor } from "@/lib/format";
import { usePolling, useSolPrice } from "@/lib/hooks";

type Wallet = { equity: number; pnlSol: number; todayPnlSol: number; startCash: number; open: number; paused: string | null; cooldownUntil: number };

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/market", label: "Market" },
  { href: "/performance", label: "Performance" },
];

export default function Header() {
  const path = usePathname();
  const solUsd = useSolPrice();
  const { data: w, error } = usePolling<Wallet>("/api/agent/wallet", 3_000);
  const status = error ? "offline" : !w ? "connecting" : w.paused ? "paused" : w.cooldownUntil > Date.now() ? "cooling down" : "trading";
  const dot = status === "trading" ? "bg-emerald-500 animate-pulse" : status === "offline" ? "bg-rose-500" : "bg-amber-400";

  return (
    <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <Link href="/" className="flex items-center gap-2 font-bold tracking-tight">
          <span className="text-xl">☢️</span>
          <span>Don&apos;t Get Nuked</span>
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-400">paper</span>
        </Link>
        <nav className="flex gap-1">
          {NAV.map((n) => {
            const active = n.href === "/" ? path === "/" : path.startsWith(n.href) || (n.href === "/market" && path.startsWith("/coin"));
            return (
              <Link
                key={n.href}
                href={n.href}
                className={`rounded-md px-3 py-1.5 text-sm ${active ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-white"}`}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-5 text-sm">
          <span className="flex items-center gap-1.5 text-xs text-zinc-400" title={w?.paused ?? error ?? ""}>
            <span className={`h-2 w-2 rounded-full ${dot}`} /> Agent {status}
          </span>
          <div className="text-right">
            <div className="text-[11px] uppercase text-zinc-500">Wallet</div>
            <div className="num">
              {w ? `${w.equity.toFixed(3)} SOL` : "…"}
              {w && solUsd > 0 && <span className="ml-1 text-zinc-500">{fmtCompact(w.equity * solUsd)}</span>}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[11px] uppercase text-zinc-500">All-time</div>
            <div className={`num ${pnlColor(w?.pnlSol ?? 0)}`}>{w ? `${((w.pnlSol / w.startCash) * 100).toFixed(2)}%` : "…"}</div>
          </div>
        </div>
      </div>
    </header>
  );
}
