import { NextResponse } from "next/server";
import { listWslDistros } from "@openlive/shared/node";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The WSL2 distros to offer under Settings > Agents. Empty off Windows, which is
// how the page knows not to show the option.
export async function GET() {
  return NextResponse.json({ distros: await listWslDistros() });
}
