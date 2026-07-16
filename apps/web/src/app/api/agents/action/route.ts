import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { widenedPath } from "@openlive/shared/node";
import { actionCommand, agentById, type Action } from "../agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Run install / uninstall / login / update for one agent and stream the process
// output back as plain text so the panel can show it live. install/uninstall run
// headless; login opens the agent's own browser sign-in (a Terminal on macOS) and
// returns quickly. A failed global npm install from a root-owned prefix (EACCES)
// gets actionable guidance appended instead of just a raw dump.
const NPM_EACCES_HELP = `
⚠ npm can't write to its global folder (permission denied).
Fix it once, then retry:
  mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global
  (add ~/.npm-global/bin to your PATH)
Or install Node via Homebrew or nvm, which use a user-writable prefix.
`;

export async function POST(req: Request) {
  const { id, action } = (await req.json().catch(() => ({}))) as { id?: string; action?: Action };
  const agent = id ? agentById(id) : undefined;
  const spec = agent && action ? actionCommand(agent, action) : null;
  if (!agent || !action || !spec) return NextResponse.json({ error: "Unknown agent or action." }, { status: 400 });

  const child = spawn(spec.cmd, spec.args, { env: { ...process.env, PATH: widenedPath() } });
  const enc = new TextEncoder();
  let sawEacces = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (s: string) => { try { controller.enqueue(enc.encode(s)); } catch { /* closed */ } };
      const watch = (s: string) => { if (/EACCES|EPERM|permission denied/i.test(s)) sawEacces = true; return s; };
      push(`$ ${spec.cmd} ${spec.args.join(" ")}\n`);
      child.stdout.on("data", (d: Buffer) => push(watch(d.toString())));
      child.stderr.on("data", (d: Buffer) => push(watch(d.toString())));
      child.on("error", (e) => { push(`\n[error] ${e.message}\n`); controller.close(); });
      child.on("close", (code) => {
        if (spec.cmd === "npm" && code !== 0 && sawEacces) push(NPM_EACCES_HELP);
        push(
          spec.terminal && code === 0
            ? "\n✓ Continues in the terminal window that opened — finish there, then Re-check.\n"
            : `\n[exit ${code ?? 0}]\n`,
        );
        controller.close();
      });
    },
    cancel() { child.kill(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" } });
}
