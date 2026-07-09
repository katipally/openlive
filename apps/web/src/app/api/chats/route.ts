import { NextResponse } from "next/server";
import { listChats } from "@openlive/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// All saved conversations (newest first), for the Conversations menu.
export function GET() {
  return NextResponse.json(listChats());
}
