import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same-origin proxy for the agent's /reminders REST surface, injecting the shared
// secret server-side.
const AGENT = `http://localhost:${process.env.AGENT_PORT || 8787}`;
const SECRET = process.env.OPENLIVE_AGENT_SECRET?.trim() || "";

async function forward(req: NextRequest, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path = [] } = await params;
  const read = req.method === "GET" || req.method === "HEAD";
  try {
    const res = await fetch(`${AGENT}/reminders${path.length ? `/${path.map(encodeURIComponent).join("/")}` : ""}${req.nextUrl.search}`, {
      method: req.method,
      headers: { "content-type": "application/json", ...(SECRET ? { "x-openlive-secret": SECRET } : {}) },
      body: read ? undefined : await req.text(),
      cache: "no-store",
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(8000)]),
    });
    return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "The agent service isn't reachable." }, { status: 503 });
  }
}

export { forward as GET, forward as DELETE };
