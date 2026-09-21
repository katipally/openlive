import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same-origin hop to the agent service, which is the only process that can
// start a coding agent and ask it what it can be set to.
const AGENT = `http://localhost:${process.env.AGENT_PORT || 8787}`;
const SECRET = process.env.OPENLIVE_AGENT_SECRET?.trim() || "";

export async function GET(req: NextRequest) {
  const agent = req.nextUrl.searchParams.get("agent")?.trim() ?? "";
  try {
    const res = await fetch(`${AGENT}/agents/models?agent=${encodeURIComponent(agent)}`, {
      headers: SECRET ? { "x-openlive-secret": SECRET } : {},
      cache: "no-store",
    });
    return new Response(await res.text(), {
      status: res.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch {
    return Response.json({ error: "The agent service is not reachable." }, { status: 503 });
  }
}
