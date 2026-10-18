import { getGraduatedPools } from "@/lib/market";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("tokens") ?? "";
  const tokens = raw.split(",").filter((a) => ADDRESS.test(a));
  try {
    return Response.json(await getGraduatedPools(tokens));
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}
