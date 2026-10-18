"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePairs, useSolPrice } from "@/lib/hooks";
import { poolFor, quoteSell } from "@/lib/amm";
import { fmtCompact, fmtPct, fmtSol, pnlColor } from "@/lib/format";
import { useWallet } from "@/lib/wallet";

export default function Header() {
  const path = usePathname();
  const { state, hydrated } = useWallet();
  const solUsd = useSolPrice();
  const { pairs } = usePairs(Object.keys(state.positions), 10_000);

  // Net worth = SOL + what every bag would actually fetch if sold right now.
  let holdingsSol = 0;
  for (const pos of Object.values(state.positions)) {
    const pair = pairs[pos.pairAddress];
    const pool = pair && poolFor(pair, solUsd);
    holdingsSol += pool ? quoteSell(pool, pos.tokens).solOut : pos.costSol;
  }
  const equity = state.sol + holdingsSol;
  const pnlPct = ((equity - state.startSol) / state.startSol) * 100;

  const nav = [
    { href: "/", label: "Discover" },
    { href: "/portfolio", label: "Portfolio" },
  ];

  return (
    <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <Link href="/" className="flex items-center gap-2 font-bold tracking-tight">
          <span className="text-xl">☢️</span>
          <span>Don&apos;t Get Nuked</span>
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-400">paper</span>
        </Link>
        <nav className="flex gap-1">
          {nav.map((n) => {
            const active = n.href === "/" ? path === "/" || path.startsWith("/coin") : path.startsWith(n.href);
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
          <div className="text-right">
            <div className="text-[11px] uppercase text-zinc-500">Cash</div>
            <div className="num">{hydrated ? fmtSol(state.sol) : "…"}</div>
          </div>
          <div className="text-right">
            <div className="text-[11px] uppercase text-zinc-500">Net worth</div>
            <div className="num">
              {hydrated ? fmtSol(equity) : "…"}
              {solUsd > 0 && <span className="ml-1 text-zinc-500">{fmtCompact(equity * solUsd)}</span>}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[11px] uppercase text-zinc-500">All-time</div>
            <div className={`num ${pnlColor(pnlPct)}`}>{hydrated ? fmtPct(pnlPct) : "…"}</div>
          </div>
        </div>
      </div>
    </header>
  );
}
