import { NextResponse } from "next/server";
import { listSessions, searchSessions } from "@openlive/flow-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One page of Flow's history. The store's listing is already bounded by design
// (filenames sort chronologically, only the page is opened, search caps its own
// scan), so this route passes a limit through and never reads the archive.

const MAX_LIMIT = 200;

export function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const query = params.get("q")?.trim() ?? "";
  const asked = Number(params.get("limit"));
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_LIMIT) : 40;
  const sessions = query ? searchSessions(query, limit) : listSessions(limit);
  return NextResponse.json({ sessions, query });
}
