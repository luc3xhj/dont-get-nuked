// What actually predicts winners? Joins every benchmark (shadow) trade to the screens and features the
// agent saw when its setup fired, then compares outcomes. Recommendations only appear with enough trades;
// nothing is auto-applied — small samples in this market are mostly noise.
import { CONFIG } from "./config";
import { db } from "./db";

type Closed = { mint: string; setup: string; openedAt: number; pnlSol: number; r: number; account: string; version?: string };
type Signal = { ts: number; mint: string; setup: string; screens: { id: string; level: string }[]; features: Record<string, unknown> | null };
type Row = { r: number; win: boolean; setup: string; screens: Map<string, string>; f: Record<string, unknown> | null };
type Stat = { n: number; winRate: number; avgR: number };

const MIN_N = 15;

const stat = (rows: { r: number; win: boolean }[]): Stat => ({
  n: rows.length,
  winRate: rows.length ? rows.filter((x) => x.win).length / rows.length : 0,
  avgR: rows.length ? rows.reduce((a, x) => a + x.r, 0) / rows.length : 0,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const get = (f: any, path: string): number | null => {
  const v = path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), f);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

const FEATURES: { key: string; label: string; value: (f: Record<string, unknown>) => number | null }[] = [
  { key: "buyers60s", label: "Buyers in last 60s", value: (f) => get(f, "flow60s.buyers") },
  {
    key: "buyShare60s",
    label: "Buy share of 60s flow",
    value: (f) => {
      const b = get(f, "flow60s.buySol");
      const s = get(f, "flow60s.sellSol");
      return b !== null && s !== null && b + s > 0 ? b / (b + s) : null;
    },
  },
  { key: "newBuyers60s", label: "New-wallet share of 60s buyers", value: (f) => get(f, "flow60s.newBuyerShare") },
  { key: "exhaustion", label: "Seller exhaustion", value: (f) => get(f, "exhaustion") },
  { key: "maxDrawdown", label: "Dump depth from ATH", value: (f) => get(f, "maxDrawdown") },
  { key: "bounce", label: "Bounce off the low", value: (f) => get(f, "bounceFromLow") },
  { key: "insiders", label: "Insider supply held %", value: (f) => get(f, "cohorts.insiders.heldPct") },
  { key: "wash", label: "Wash score", value: (f) => get(f, "volume.washScore") },
  { key: "top10Vol", label: "Top-10 wallets' volume share", value: (f) => get(f, "volume.top10VolShare") },
  { key: "age", label: "Coin age (min)", value: (f) => get(f, "ageMin") },
  { key: "trackedTraders", label: "Watched + discovered traders holding", value: (f) => {
    const w = get(f, "tracked.watching");
    const d = get(f, "tracked.discovered");
    return w === null && d === null ? null : (w ?? 0) + (d ?? 0);
  } },
];

const versionOf = (c: Closed) => c.version ?? "legacy";

function rows(versions: string[] | null): { shadow: Row[]; baselineR: number[] } {
  const closed = (db.prepare("SELECT data FROM closed WHERE account IN ('shadow', 'baseline')").all() as { data: string }[])
    .map((r) => JSON.parse(r.data) as Closed)
    .filter((c) => !versions || versions.includes(versionOf(c)));
  const signals = new Map<string, Signal[]>();
  for (const r of db.prepare("SELECT ts, mint, data FROM journal WHERE kind = 'signal'").all() as { ts: number; mint: string; data: string }[]) {
    const d = JSON.parse(r.data);
    const sig: Signal = { ts: r.ts, mint: r.mint, setup: d.setup, screens: d.screens ?? [], features: d.features ?? null };
    const key = `${r.mint}:${d.setup}`;
    signals.set(key, [...(signals.get(key) ?? []), sig]);
  }
  const shadow: Row[] = [];
  for (const c of closed.filter((x) => x.account === "shadow")) {
    // The signal that opened this trade: same coin and setup, shortly before the fill.
    const sig = (signals.get(`${c.mint}:${c.setup}`) ?? []).filter((s) => s.ts <= c.openedAt && c.openedAt - s.ts < 120_000).at(-1);
    shadow.push({ r: c.r, win: c.pnlSol > 0, setup: c.setup, screens: new Map((sig?.screens ?? []).map((x) => [x.id, x.level])), f: sig?.features ?? null });
  }
  return { shadow, baselineR: closed.filter((x) => x.account === "baseline").map((x) => x.r) };
}

/** 90% bootstrap interval for mean(a) − mean(b). */
function bootstrapDiff(a: number[], b: number[], iters = 2000): [number, number] | null {
  if (a.length < 5 || b.length < 5) return null;
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const pick = (xs: number[]) => Array.from({ length: xs.length }, () => xs[Math.floor(Math.random() * xs.length)]);
  const diffs = Array.from({ length: iters }, () => mean(pick(a)) - mean(pick(b))).sort((x, y) => x - y);
  return [diffs[Math.floor(iters * 0.05)], diffs[Math.floor(iters * 0.95)]];
}

/** Benchmark trades per strategy version ("legacy" = before versioning), so versions are never pooled silently. */
function byVersion() {
  const closed = (db.prepare("SELECT data FROM closed WHERE account = 'shadow'").all() as { data: string }[]).map((r) => JSON.parse(r.data) as Closed);
  const out: Record<string, Stat> = {};
  for (const v of new Set(closed.map(versionOf))) out[v] = stat(closed.filter((c) => versionOf(c) === v).map((c) => ({ r: c.r, win: c.pnlSol > 0 })));
  return out;
}

/** Evidence from the listed strategy versions only (default: the ones the agent learns from); null = all. */
export function evidenceReport(versions: string[] | null = CONFIG.evidenceVersions) {
  const { shadow, baselineR } = rows(versions);
  const recommendations: string[] = [];

  // Setups vs random coins: is there any selection edge at all?
  const edgeCi = bootstrapDiff(
    shadow.map((x) => x.r),
    baselineR
  );
  const edge = {
    setups: stat(shadow),
    random: stat(baselineR.map((r) => ({ r, win: r > 0 }))),
    diffCi90: edgeCi,
    verdict:
      edgeCi === null
        ? "Not enough trades yet"
        : edgeCi[0] > 0
          ? "Setups beat random coins (90% interval above zero)"
          : edgeCi[1] < 0
            ? "Setups are doing WORSE than random coins"
            : "No significant difference from random coins yet",
  };

  // Screens: outcome by the level each screen showed at entry.
  const screenIds = [...new Set(shadow.flatMap((x) => [...x.screens.keys()]))];
  const screens = screenIds.map((id) => {
    const levels: Record<string, Stat> = {};
    for (const level of ["ok", "warn", "veto", "unknown"]) {
      const sub = shadow.filter((x) => x.screens.get(id) === level);
      if (sub.length) levels[level] = stat(sub);
    }
    const ok = levels.ok;
    const bad = levels.warn ?? levels.veto;
    if (ok && bad && ok.n >= MIN_N && bad.n >= MIN_N) {
      if (bad.avgR < ok.avgR - 0.3)
        recommendations.push(`"${id}" warnings predict worse trades (${bad.avgR.toFixed(2)}R vs ${ok.avgR.toFixed(2)}R): consider making it a veto.`);
      else if (bad.avgR >= ok.avgR) recommendations.push(`"${id}" warnings don't predict worse trades yet (${bad.avgR.toFixed(2)}R vs ${ok.avgR.toFixed(2)}R).`);
    }
    return { id, levels };
  });

  // Features: outcome by tertile of each value at entry.
  const features = FEATURES.map(({ key, label, value }) => {
    const vals = shadow.map((x) => ({ x, v: x.f ? value(x.f) : null })).filter((p): p is { x: Row; v: number } => p.v !== null);
    if (vals.length < 9) return { key, label, n: vals.length, buckets: [] };
    const sorted = [...vals].sort((a, b) => a.v - b.v);
    const third = Math.ceil(sorted.length / 3);
    const buckets = [0, 1, 2].map((i) => {
      const part = sorted.slice(i * third, (i + 1) * third);
      return { lo: part[0].v, hi: part.at(-1)!.v, ...stat(part.map((p) => p.x)) };
    });
    const [low, , high] = buckets;
    if (low.n >= MIN_N && high.n >= MIN_N && Math.abs(high.avgR - low.avgR) > 0.5)
      recommendations.push(`${label}: ${high.avgR > low.avgR ? "higher" : "lower"} values did better (${high.avgR.toFixed(2)}R vs ${low.avgR.toFixed(2)}R).`);
    return { key, label, n: vals.length, buckets };
  });

  return {
    versions: versions ?? "all",
    byVersion: byVersion(),
    trades: shadow.length,
    joined: shadow.filter((x) => x.f).length,
    minN: MIN_N,
    edge,
    screens,
    features,
    recommendations: recommendations.length ? recommendations : [`Not enough evidence yet: recommendations need ≥ ${MIN_N} trades on each side of a comparison.`],
  };
}
