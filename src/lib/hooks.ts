"use client";

import { useEffect, useState } from "react";

/** Fetch JSON now and every `intervalMs`, pausing while the tab is hidden unless `background` is set. */
export function usePolling<T>(url: string | null, intervalMs: number, background = false) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let first = true;
    const tick = async () => {
      if (first || background || !document.hidden) {
        first = false;
        try {
          const res = await fetch(url);
          const json = await res.json();
          if (cancelled) return;
          if (!res.ok) throw new Error(json.error ?? res.statusText);
          setData(json);
          setError(null);
          setUpdatedAt(Date.now());
        } catch (e) {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        }
      }
      if (!cancelled) timer = setTimeout(tick, intervalMs);
    };
    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [url, intervalMs, background]);

  return { data, error, updatedAt };
}

export function useSolPrice(background = false) {
  const { data } = usePolling<{ priceUsd: number }>("/api/sol", 15_000, background);
  return data?.priceUsd ?? 0;
}
