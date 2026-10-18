const SUB = "₀₁₂₃₄₅₆₇₈₉";

/** Meme-coin friendly price: $0.0₅1234 for tiny values. */
export function fmtPrice(v: number, prefix = "$"): string {
  if (!Number.isFinite(v) || v === 0) return `${prefix}0`;
  // Chart axes can dip below zero.
  if (v < 0) return `-${fmtPrice(-v, prefix)}`;
  if (v >= 1) return prefix + v.toLocaleString("en-US", { maximumFractionDigits: v >= 1000 ? 2 : 4 });
  if (v >= 0.001) return prefix + v.toFixed(6).replace(/0+$/, "");
  // Subscript = zeros after "0.0"; ceil (not floor) so exact powers of ten (0.00001) count right.
  let zeros = Math.ceil(-Math.log10(v)) - 2;
  let n = Math.round(v * 10 ** (zeros + 4));
  // Three significant digits; rounding can carry into a fourth (999.6 → 1000): one fewer zero.
  if (n >= 1_000) {
    zeros--;
    n = Math.round(v * 10 ** (zeros + 4));
  }
  const digits = n.toString().slice(0, 4);
  const sub = String(zeros).split("").map((d) => SUB[Number(d)]).join("");
  return `${prefix}0.0${sub}${digits}`;
}

export function fmtCompact(v: number, prefix = "$"): string {
  if (!Number.isFinite(v)) return "–";
  return prefix + new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(v);
}

export function fmtSol(v: number, digits = 3): string {
  return `${v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })} SOL`;
}

export function fmtPct(v: number, digits = 1): string {
  if (!Number.isFinite(v)) return "–";
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

export function fmtTokens(v: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(v);
}

export function fmtAge(from: number | string | null): string {
  if (!from) return "–";
  const ms = Date.now() - new Date(from).getTime();
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export const pnlColor = (v: number) => (v > 0 ? "text-emerald-400" : v < 0 ? "text-rose-400" : "text-zinc-400");
