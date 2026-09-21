import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { NextResponse } from "next/server";
import { resolveAsset } from "@openlive/flow-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  wav: "audio/wav", webm: "audio/webm", mp3: "audio/mpeg", txt: "text/plain; charset=utf-8", json: "application/json",
};

/** One captured asset's bytes. The name is reduced to a basename and the path is
 *  re-resolved inside the store, so a crafted name cannot reach a file the
 *  person never captured. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const name = basename(new URL(req.url).searchParams.get("name") ?? "");
  if (!name || !id) return new NextResponse("Not found", { status: 404 });
  let bytes: Buffer;
  try { bytes = readFileSync(resolveAsset(`assets/${basename(id)}/${name}`)); }
  catch { return new NextResponse("Not found", { status: 404 }); }
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      // Written once and never rewritten, and they are local files.
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
