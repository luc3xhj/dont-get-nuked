import { getPairs } from "@/lib/market";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("addresses") ?? "";
  const addresses = raw.split(",").filter((a) => ADDRESS.test(a));
  try {
    return Response.json(await getPairs(addresses));
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}
