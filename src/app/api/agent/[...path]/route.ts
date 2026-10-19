// Proxy to the local agent worker (npm run agent), which only listens on 127.0.0.1.
const AGENT = `http://127.0.0.1:${process.env.AGENT_PORT ?? 3101}`;

async function proxy(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  if (!path.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return Response.json({ error: "bad path" }, { status: 400 });
  try {
    const res = await fetch(`${AGENT}/api/${path.join("/")}${new URL(req.url).search}`, {
      method: req.method,
      cache: "no-store",
      // Forward JSON bodies (e.g. adding a wallet to the watchlist).
      ...(req.method === "POST" ? { body: await req.text(), headers: { "content-type": "application/json" } } : {}),
      signal: AbortSignal.timeout(5_000),
    });
    // Pass through the worker's content type (JSON, or CSV for the dataset export).
    const headers = new Headers({ "content-type": res.headers.get("content-type") ?? "application/json" });
    const disposition = res.headers.get("content-disposition");
    if (disposition) headers.set("content-disposition", disposition);
    return new Response(res.body, { status: res.status, headers });
  } catch {
    return Response.json({ error: "Agent worker is not running. Start it with `npm run agent`." }, { status: 503 });
  }
}

export { proxy as GET, proxy as POST };
