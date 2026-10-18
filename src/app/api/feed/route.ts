import { getFeed } from "@/lib/feed";
import { getSolPrice, type TrendingDuration } from "@/lib/market";
import type { FeedView } from "@/lib/types";

const VIEWS: FeedView[] = ["new", "stretch", "migrated", "trending"];
const DURATIONS: TrendingDuration[] = ["5m", "1h", "6h", "24h"];

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const view = VIEWS.find((v) => v === params.get("view")) ?? "new";
  const duration = DURATIONS.find((d) => d === params.get("tf")) ?? "1h";
  try {
    const solUsd = await getSolPrice().catch(() => 0);
    return Response.json(await getFeed(view, duration, solUsd));
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}
