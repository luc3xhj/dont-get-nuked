"use client";

// Shared status primitives for the terminal: every panel states its status with the same colors,
// so "is this fine?" can be answered at a glance before reading any detail.

export type Tone = "ok" | "warn" | "bad" | "info" | "live" | "idle";

export const TONE_TEXT: Record<Tone, string> = {
  ok: "text-emerald-300",
  warn: "text-amber-300",
  bad: "text-rose-300",
  info: "text-violet-300",
  live: "text-sky-300",
  idle: "text-zinc-500",
};

const PILL: Record<Tone, string> = {
  ok: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  warn: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  bad: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
  info: "bg-violet-500/15 text-violet-300 ring-violet-500/30",
  live: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
  idle: "bg-zinc-800/80 text-zinc-400 ring-zinc-700",
};

export const ACCENT: Record<Tone, string> = {
  ok: "border-l-emerald-500/70",
  warn: "border-l-amber-500/70",
  bad: "border-l-rose-500/80",
  info: "border-l-violet-500/70",
  live: "border-l-sky-500/70",
  idle: "border-l-zinc-700",
};

const ICON: Record<Tone, string> = { ok: "✓", warn: "!", bad: "✕", info: "◆", live: "●", idle: "–" };

export function Pill({ tone, children, icon = true, size = "sm" }: { tone: Tone; children: React.ReactNode; icon?: boolean; size?: "sm" | "md" }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md font-semibold uppercase tracking-wide ring-1 ring-inset ${PILL[tone]} ${
        size === "md" ? "px-2 py-1 text-[11px]" : "px-1.5 py-0.5 text-[10px]"
      }`}
    >
      {icon && <span aria-hidden>{ICON[tone]}</span>}
      {children}
    </span>
  );
}

export type ChipData = { label?: string; value: React.ReactNode; tone?: Tone };

/** Numbers get the tabular font; words stay in the reading font. */
export const numeric = (v: React.ReactNode) => typeof v === "number" || (typeof v === "string" && /^[+\-−×$]?[\d.]/.test(v));

export function Chip({ label, value, tone }: ChipData) {
  return (
    <span className="inline-flex shrink-0 items-baseline gap-1 whitespace-nowrap rounded bg-white/[0.035] px-1.5 py-0.5 text-[11px]">
      {label && <span className="text-zinc-500">{label}</span>}
      <span className={`${numeric(value) ? "num" : ""} ${tone ? TONE_TEXT[tone] : "text-zinc-200"}`}>{value}</span>
    </span>
  );
}

/** A labelled number in a small grid cell. */
export function Metric({ label, value, tone, hint }: { label: string; value: React.ReactNode; tone?: Tone; hint?: string }) {
  return (
    <div className="min-w-0 rounded-md bg-white/[0.025] px-2.5 py-1.5" title={hint}>
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`${numeric(value) ? "num" : ""} truncate text-[13px] ${tone ? TONE_TEXT[tone] : "text-zinc-100"}`}>{value}</div>
    </div>
  );
}

/** Collapsible panel whose header always shows its status (badge) and key numbers (chips). */
export function Section({
  id,
  title,
  tone,
  badge,
  chips,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  tone: Tone;
  badge: React.ReactNode;
  chips: ChipData[];
  open: boolean;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}) {
  return (
    <section id={`section-${id}`} className={`scroll-mt-2 overflow-hidden rounded-lg border border-l-2 border-line bg-panel ${ACCENT[tone]}`}>
      <button onClick={() => onToggle(id)} aria-expanded={open} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-white/[0.015]">
        <span className={`text-[9px] text-zinc-500 transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
        <span className="w-28 shrink-0 text-[13px] font-medium text-zinc-100 sm:w-40">{title}</span>
        <Pill tone={tone}>{badge}</Pill>
        <span className="flex min-w-0 flex-1 gap-1.5 overflow-hidden">
          {chips.map((c, i) => (
            <Chip key={i} {...c} />
          ))}
        </span>
      </button>
      {open && <div className="border-t border-line px-3 py-3">{children}</div>}
    </section>
  );
}

/** Thin progress bar for "n of m checks pass". */
export function Progress({ done, total, tone }: { done: number; total: number; tone: Tone }) {
  const pct = total ? (done / total) * 100 : 0;
  const bar: Record<Tone, string> = { ok: "bg-emerald-400", warn: "bg-amber-400", bad: "bg-rose-400", info: "bg-violet-400", live: "bg-sky-400", idle: "bg-zinc-600" };
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-800">
      <div className={`h-full rounded-full ${bar[tone]}`} style={{ width: `${pct}%` }} />
    </div>
  );
}
