import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { widenedPath } from "@openlive/shared/node";
import { actionCommand, agentById, type Action } from "../agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Run install / uninstall / login for one agent and stream the process output back as
// plain text so the panel can show it live. install/uninstall run headless; login opens
// the agent's own browser sign-in (a Terminal on macOS) and returns quickly.
// ponytail: global npm installs can fail with EACCES if the user's npm prefix isn't
// user-writable — the streamed error surfaces it; they fall back to a manual install.
export async function POST(req: Request) {
  const { id, action } = (await req.json().catch(() => ({}))) as { id?: string; action?: Action };
  const agent = id ? agentById(id) : undefined;
  const spec = agent && action ? actionCommand(agent, action) : null;
  if (!agent || !action || !spec) return NextResponse.json({ error: "Unknown agent or action." }, { status: 400 });

  const child = spawn(spec.cmd, spec.args, { env: { ...process.env, PATH: widenedPath() } });
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (s: string) => { try { controller.enqueue(enc.encode(s)); } catch { /* closed */ } };
      push(`$ ${spec.cmd} ${spec.args.join(" ")}\n`);
      child.stdout.on("data", (d: Buffer) => push(d.toString()));
      child.stderr.on("data", (d: Buffer) => push(d.toString()));
      child.on("error", (e) => { push(`\n[error] ${e.message}\n`); controller.close(); });
      child.on("close", (code) => {
        push(
          action === "login" && code === 0 ? "\n✓ Sign-in started — finish it in the window that opened, then Re-check.\n"
            : action === "logout" && code === 0 ? "\n✓ Sign-out started — it completes in the window that opened, then Re-check.\n"
              : `\n[exit ${code ?? 0}]\n`,
        );
        controller.close();
      });
    },
    cancel() { child.kill(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" } });
}
