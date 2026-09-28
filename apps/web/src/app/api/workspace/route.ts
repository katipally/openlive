import { NextResponse } from "next/server";
import { statSync } from "node:fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Pre-call check: does the chosen project folder actually exist (and is it a
// directory)? The lobby gates Start on this — a deleted/renamed/typo'd folder
// used to surface only as a confusing mid-call failure.
export async function GET(req: Request) {
  const path = new URL(req.url).searchParams.get("path") ?? "";
  if (!path) return NextResponse.json({ ok: false, reason: "empty" });
  try {
    // The path is the user's project folder, not ours: keep Turbopack from
    // tracing the whole repo into the server bundle for it.
    const s = statSync(/*turbopackIgnore: true*/ path);
    return NextResponse.json(s.isDirectory() ? { ok: true } : { ok: false, reason: "not-a-folder" });
  } catch {
    return NextResponse.json({ ok: false, reason: "missing" });
  }
}
