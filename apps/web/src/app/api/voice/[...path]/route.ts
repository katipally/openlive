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
  // A status read must not hang when the agent is down or wedged; synthesis and
  // the model download legitimately take long, so only reads get a deadline.
  const read = req.method === "GET" || req.method === "HEAD";
  let res: Response;
  try {
    res = await fetch(url, {
      method: req.method,
      headers: {
        "content-type": req.headers.get("content-type") ?? "application/json",
        ...(SECRET ? { "x-openlive-secret": SECRET } : {}),
      },
      body: read ? undefined : req.body,
      // @ts-expect-error node fetch needs duplex for streamed request bodies
      duplex: "half",
      // The browser hanging up reaches the agent: a sentence cut by barge-in
      // while still queued must not be synthesized anyway.
      signal: read ? AbortSignal.any([req.signal, AbortSignal.timeout(8000)]) : req.signal,
    });
  } catch (e) {
    const timedOut = (e as Error)?.name === "TimeoutError";
    return Response.json({ error: timedOut ? "The voice engine did not answer in time." : "The voice engine is not reachable." }, { status: timedOut ? 504 : 502 });
  }
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

export { forward as GET, forward as POST, forward as DELETE, forward as PATCH, forward as PUT };
