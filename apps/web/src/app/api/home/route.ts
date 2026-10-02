import { NextResponse } from "next/server";
import { resolveHome } from "@openlive/shared/home";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The folder OpenLive keeps everything in, for Settings > About to show. The
// desktop shell hands the servers OPENLIVE_HOME, so this is the folder "Open"
// shows too.
export function GET() {
  return NextResponse.json({ home: resolveHome() });
}
