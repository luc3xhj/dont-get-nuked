import { fmtPct, pnlColor } from "@/lib/format";

export default function Change({ v }: { v: number }) {
  return <span className={`num ${pnlColor(v)}`}>{fmtPct(v)}</span>;
}
