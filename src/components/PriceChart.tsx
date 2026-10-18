"use client";

import { CandlestickSeries, createChart, HistogramSeries, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { fmtPrice } from "@/lib/format";
import type { Candle } from "@/lib/types";

const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
type Tf = (typeof TIMEFRAMES)[number];
const BUCKET: Record<Tf, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };


export default function PriceChart({ pairAddress, livePrice }: { pairAddress: string; livePrice: number }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volume = useRef<ISeriesApi<"Histogram"> | null>(null);
  const last = useRef<Candle | null>(null);
  const [tf, setTf] = useState<Tf>("1m");
  const [status, setStatus] = useState<"loading" | "ready" | "empty" | "error">("loading");

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: "#a1a1aa", fontFamily: "var(--font-geist-mono)" },
      grid: { vertLines: { color: "#18181b" }, horzLines: { color: "#18181b" } },
      rightPriceScale: { borderColor: "#27272a" },
      timeScale: { borderColor: "#27272a", timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    candles.current = c.addSeries(CandlestickSeries, {
      upColor: "#34d399",
      downColor: "#fb7185",
      borderVisible: false,
      wickUpColor: "#34d399",
      wickDownColor: "#fb7185",
      priceFormat: { type: "custom", formatter: (p: number) => fmtPrice(p), minMove: 1e-12 },
    });
    volume.current = c.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" } });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout>;
    setStatus("loading");
    const load = () =>
      fetch(`/api/candles?pair=${pairAddress}&tf=${tf}`)
        .then((r) => r.json())
        .then((data: Candle[] | { error: string }) => {
          if (cancelled || !candles.current || !volume.current) return;
          if (!Array.isArray(data)) {
            // Usually a GeckoTerminal rate limit; try again shortly.
            setStatus("error");
            retry = setTimeout(load, 10_000);
            return;
          }
          candles.current.setData(data.map((d) => ({ ...d, time: d.time as UTCTimestamp })));
          volume.current.setData(
            data.map((d) => ({ time: d.time as UTCTimestamp, value: d.volume, color: d.close >= d.open ? "#34d39940" : "#fb718540" }))
          );
          last.current = data.at(-1) ?? null;
          chart.current?.timeScale().fitContent();
          setStatus(data.length ? "ready" : "empty");
        })
        .catch(() => {
          if (cancelled) return;
          setStatus("error");
          retry = setTimeout(load, 10_000);
        });
    load();
    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
  }, [pairAddress, tf]);

  // Stream the polled live price into the current candle so the chart ticks between OHLCV refreshes.
  useEffect(() => {
    if (!livePrice || !candles.current || status !== "ready") return;
    const bucket = BUCKET[tf];
    const now = Math.floor(Date.now() / 1000 / bucket) * bucket;
    const prev = last.current;
    const bar: Candle =
      prev && prev.time === now
        ? { ...prev, high: Math.max(prev.high, livePrice), low: Math.min(prev.low, livePrice), close: livePrice }
        : prev && prev.time > now
          ? prev
          : { time: now, open: prev?.close ?? livePrice, high: Math.max(prev?.close ?? livePrice, livePrice), low: Math.min(prev?.close ?? livePrice, livePrice), close: livePrice, volume: 0 };
    if (bar === prev) return;
    last.current = bar;
    candles.current.update({ ...bar, time: bar.time as UTCTimestamp });
  }, [livePrice, tf, status]);

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950">
      <div className="flex items-center gap-1 border-b border-zinc-800 px-2 py-1.5">
        {TIMEFRAMES.map((t) => (
          <button
            key={t}
            onClick={() => setTf(t)}
            className={`rounded px-2 py-1 text-xs ${tf === t ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-white"}`}
          >
            {t}
          </button>
        ))}
        <span className="ml-auto pr-2 text-xs text-zinc-500">
          {status === "loading" && "Loading candles…"}
          {status === "empty" && "No candle data yet"}
          {status === "error" && "Rate limited — retrying…"}
        </span>
      </div>
      <div ref={el} className="h-[420px] w-full" />
    </div>
  );
}
