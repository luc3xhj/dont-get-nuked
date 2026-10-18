import { getSolPrice } from "@/lib/market";

export async function GET() {
  try {
    return Response.json({ priceUsd: await getSolPrice() });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}
