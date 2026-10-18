import { getCandles, isTimeframe } from "@/lib/market";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const pair = params.get("pair") ?? "";
  const tf = params.get("tf") ?? "1m";
  if (!ADDRESS.test(pair) || !isTimeframe(tf)) return Response.json({ error: "bad params" }, { status: 400 });
  try {
    return Response.json(await getCandles(pair, tf));
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}
