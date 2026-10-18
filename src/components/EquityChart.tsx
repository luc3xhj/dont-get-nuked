"use client";

/** Lightweight SVG equity curve with start line and min/max labels. */
export default function EquityChart({ points, start, height = 140 }: { points: [number, number][]; start: number; height?: number }) {
  if (points.length < 2)
    return (
      <div className="flex items-center justify-center text-xs text-zinc-600" style={{ height }}>
        The equity curve fills in once the agent has run for a few minutes.
      </div>
    );
  const ys = points.map((p) => p[1]);
  const min = Math.min(...ys, start);
  const max = Math.max(...ys, start);
  const span = max - min || 1;
  const t0 = points[0][0];
  const t1 = points.at(-1)![0];
  const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * 100;
  const y = (v: number) => 92 - ((v - min) / span) * 84;
  const line = points.map((p) => `${x(p[0])},${y(p[1])}`).join(" ");
  const up = ys.at(-1)! >= start;
  return (
    <div className="relative" style={{ height }}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full">
        <line x1="0" x2="100" y1={y(start)} y2={y(start)} className="stroke-zinc-700" strokeDasharray="1 1.5" vectorEffect="non-scaling-stroke" />
        <polyline points={`0,100 ${line} 100,100`} className={up ? "fill-emerald-500/10" : "fill-rose-500/10"} stroke="none" />
        <polyline
          points={line}
          fill="none"
          strokeWidth="1.75"
          vectorEffect="non-scaling-stroke"
          className={up ? "stroke-emerald-400" : "stroke-rose-400"}
        />
      </svg>
      <span className="num absolute right-1 top-0 text-[10px] text-zinc-500">{max.toFixed(3)}◎</span>
      <span className="num absolute bottom-0 right-1 text-[10px] text-zinc-500">{min.toFixed(3)}◎</span>
    </div>
  );
}
