"use client";

import { useEffect, useState } from "react";

// Public IPFS gateways are flaky (429s, hanging requests); try a few before falling back to initials.
const GATEWAYS = ["https://pump.mypinata.cloud/ipfs/", "https://ipfs.io/ipfs/", "https://gateway.pinata.cloud/ipfs/"];
const LOAD_TIMEOUT_MS = 6_000;

function candidates(src: string): string[] {
  const m = src.match(/\/ipfs\/(.+)$/);
  if (!m) return [src];
  return [...new Set([...GATEWAYS.map((g) => g + m[1]), src])];
}

export default function TokenIcon({ src, symbol, size = 32 }: { src?: string | null; symbol: string; size?: number }) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const urls = src ? candidates(src) : [];
  const url = urls[attempt];

  useEffect(() => {
    setAttempt(0);
    setLoaded(false);
  }, [src]);

  // A hanging gateway never fires onError, so give each one a deadline.
  useEffect(() => {
    if (!url || loaded) return;
    const t = setTimeout(() => setAttempt((a) => a + 1), LOAD_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [url, loaded]);

  if (url)
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        key={url}
        src={url}
        alt=""
        width={size}
        height={size}
        onLoad={() => setLoaded(true)}
        onError={() => setAttempt((a) => a + 1)}
        className="shrink-0 rounded-full bg-zinc-800 object-cover"
        style={{ width: size, height: size }}
      />
    );
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full bg-zinc-800 text-xs font-semibold text-zinc-400"
      style={{ width: size, height: size }}
    >
      {symbol.slice(0, 2).toUpperCase()}
    </div>
  );
}
