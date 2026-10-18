"use client";

import { useEffect } from "react";
import { useWallet } from "@/lib/wallet";

export default function Toaster() {
  const { notices, dismissNotice } = useWallet();

  useEffect(() => {
    if (!notices.length) return;
    const t = setTimeout(() => dismissNotice(notices[0].id), 8_000);
    return () => clearTimeout(t);
  }, [notices, dismissNotice]);

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {notices.map((n) => (
        <button
          key={n.id}
          onClick={() => dismissNotice(n.id)}
          className={`pointer-events-auto rounded-lg border px-4 py-3 text-left text-sm shadow-lg ${
            n.ok ? "border-emerald-800 bg-emerald-950 text-emerald-200" : "border-rose-800 bg-rose-950 text-rose-200"
          }`}
        >
          {n.text}
        </button>
      ))}
    </div>
  );
}
