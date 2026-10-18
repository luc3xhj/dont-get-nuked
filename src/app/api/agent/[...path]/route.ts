// Proxy to the local agent worker (npm run agent), which only listens on 127.0.0.1.
const AGENT = `http://127.0.0.1:${process.env.AGENT_PORT ?? 3101}`;

async function proxy(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  if (!path.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return Response.json({ error: "bad path" }, { status: 400 });
  try {
    const res = await fetch(`${AGENT}/api/${path.join("/")}${new URL(req.url).search}`, {
      method: req.method,
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
  } catch {
    return Response.json({ error: "Agent worker is not running. Start it with `npm run agent`." }, { status: 503 });
  }
}

export { proxy as GET, proxy as POST };
