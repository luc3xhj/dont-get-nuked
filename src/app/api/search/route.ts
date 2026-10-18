import { searchFeed } from "@/lib/feed";

export async function GET(req: Request) {
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 64);
  if (!q) return Response.json([]);
  try {
    return Response.json(await searchFeed(q));
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}
