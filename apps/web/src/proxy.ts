// Every /api route spends the user's keys, drives their coding agent or writes
// their files, and a loopback port is reachable from any page open in a browser:
// a cross-site form or text/plain POST needs no CORS preflight, and a page that
// rebinds its DNS to this machine reaches the server under its own site's name.
// Callers with no Origin, Referer or Sec-Fetch-Site are not browsers (Electron
// main, scripts, tests); a browser always sends one of them on a write.
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];
const READS = ["GET", "HEAD", "OPTIONS"];
// The body types a page on any site may send with no preflight.
const SIMPLE_TYPES = ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"];

const parse = (url: string) => { try { return new URL(url); } catch { return null; } };

/** Why a request to /api is refused, or null to let it through. */
export function refusal({ method, headers }: { method: string; headers: Headers }): { status: number; error: string } | null {
  const host = headers.get("host") ?? "";
  const forbidden = { status: 403, error: "This request did not come from OpenLive." };
  if (!LOOPBACK.includes(parse(`http://${host}`)?.hostname ?? "")) return forbidden;
  if (READS.includes(method)) return null;
  const site = headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return forbidden;
  const from = headers.get("origin") ?? headers.get("referer");
  if (from !== null && parse(from)?.host !== host) return forbidden;
  const type = (headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const body = headers.has("transfer-encoding") || Number(headers.get("content-length")) > 0;
  if (body && (!type || SIMPLE_TYPES.includes(type))) return { status: 415, error: "Send the body as JSON." };
  return null;
}

export function proxy(req: Request) {
  const no = refusal(req);
  if (no) return Response.json({ error: no.error }, { status: no.status });
}

export const config = { matcher: "/api/:path*" };
