import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same-origin proxy for the agent's /dictate surface, injecting the shared
// secret server-side. No deadline of its own: Dictate holds one, and its
// hanging up reaches the agent, which stops the brain's turn.
const AGENT = `http://localhost:${process.env.AGENT_PORT || 8787}`;
const SECRET = process.env.OPENLIVE_AGENT_SECRET?.trim() || "";

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  try {
    const res = await fetch(`${AGENT}/dictate/${path.map(encodeURIComponent).join("/")}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(SECRET ? { "x-openlive-secret": SECRET } : {}) },
      body: await req.text(),
      cache: "no-store",
      signal: req.signal,
    });
    // Passed through as it comes: a rewrite streams its words.
    return new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "The agent service isn't reachable." }, { status: 503 });
  }
}
