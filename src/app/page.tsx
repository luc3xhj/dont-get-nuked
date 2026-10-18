import { Suspense } from "react";
import Terminal from "@/components/terminal/Terminal";

export default function Home() {
  return (
    <Suspense fallback={<div className="flex h-dvh items-center justify-center text-sm text-zinc-500">Loading terminal…</div>}>
      <Terminal />
    </Suspense>
  );
}
