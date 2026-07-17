import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same-origin proxy for the agent service's /voice REST surface. One path for
// every deployment: dev and desktop hop over localhost, and the container gets
// the shared secret injected server-side (browsers can't set that header).
const AGENT = `http://localhost:${process.env.AGENT_PORT || 8787}`;
const SECRET = process.env.OPENLIVE_AGENT_SECRET?.trim() || "";

async function forward(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const url = `${AGENT}/voice/${path.join("/")}${req.nextUrl.search}`;
  const res = await fetch(url, {
    method: req.method,
    headers: {
      "content-type": req.headers.get("content-type") ?? "application/json",
      ...(SECRET ? { "x-openlive-secret": SECRET } : {}),
    },
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    // @ts-expect-error node fetch needs duplex for streamed request bodies
    duplex: "half",
  });
  // Stream the body through (download progress + PCM depend on it).
  return new Response(res.body, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/octet-stream",
      ...(res.headers.get("x-sample-rate") ? { "x-sample-rate": res.headers.get("x-sample-rate")! } : {}),
      "cache-control": "no-cache",
    },
  });
}

export { forward as GET, forward as POST, forward as DELETE, forward as PATCH };
