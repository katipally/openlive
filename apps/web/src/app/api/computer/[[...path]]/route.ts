import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same-origin proxy for the agent's /computer surface (the computer-use
// helper's grants), injecting the shared secret server-side.
const AGENT = `http://localhost:${process.env.AGENT_PORT || 8787}`;
const SECRET = process.env.OPENLIVE_AGENT_SECRET?.trim() || "";

async function forward(req: NextRequest, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;
  const read = req.method === "GET" || req.method === "HEAD";
  try {
    // A grant request waits on a system prompt being put up, so only reads get a deadline.
    const res = await fetch(`${AGENT}/computer${path.length ? `/${path.map(encodeURIComponent).join("/")}` : ""}`, {
      method: req.method,
      headers: { "content-type": "application/json", ...(SECRET ? { "x-openlive-secret": SECRET } : {}) },
      body: read ? undefined : await req.text(),
      cache: "no-store",
      signal: read ? AbortSignal.any([req.signal, AbortSignal.timeout(8000)]) : req.signal,
    });
    return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "The agent service is not reachable." }, { status: 503 });
  }
}

export { forward as GET, forward as POST };
