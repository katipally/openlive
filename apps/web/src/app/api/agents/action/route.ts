import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { widenedPath } from "@openlive/shared/node";
import type { TelemetryEventProps } from "@openlive/shared";
import { actionCommand, agentById, type Action } from "../agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Run install / uninstall / login / update for one agent and stream the process
// output back as plain text so the panel can show it live. install/uninstall run
// headless; login opens the agent's own browser sign-in (a Terminal on macOS) and
// returns quickly. A failed global npm install from a root-owned prefix (EACCES)
// gets actionable guidance appended instead of just a raw dump. The stream ends
// with one `[result <code>]` line, a closed code the panel reads (and strips)
// instead of parsing the prose above it.
type Result = Exclude<TelemetryEventProps<"agent_action_result">["result"], "signed_in" | "wait_timeout">;
const NPM_EACCES_HELP = `
⚠ npm can't write to its global folder (permission denied).
Fix it once, then retry:
  mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global
  (add ~/.npm-global/bin to your PATH)
Or install Node via Homebrew or nvm, which use a user-writable prefix.
`;

// A terminal launch that failed never reached the user's shell — on macOS the
// usual culprit is the Automation permission (osascript error -1743), which
// fails with nothing visible on screen. Always give the manual path.
const terminalHelp = (display?: string) => `
⚠ Couldn't open your terminal automatically.
${process.platform === "darwin"
  ? "macOS may be blocking automation: System Settings → Privacy & Security → Automation → allow OpenLive to control Terminal."
  : process.platform === "win32"
    ? "Your system blocked launching a terminal window from OpenLive."
    : "No terminal emulator was found. Install one (e.g. gnome-terminal, konsole, xterm) or just run the command below."}
${display ? `Run this yourself in any terminal, then hit Re-check:\n  ${display}\n` : ""}`;

export async function POST(req: Request) {
  const { id, action } = (await req.json().catch(() => ({}))) as { id?: string; action?: Action };
  const agent = id ? agentById(id) : undefined;
  const spec = agent && action ? actionCommand(agent, action) : null;
  if (!agent || !action || !spec) return NextResponse.json({ error: "Unknown agent or action." }, { status: 400 });

  // Windows: `npm` is a `.cmd` shim Node won't exec without a shell (ENOENT) — every
  // Install/Update button died there. Real .exe launchers (powershell/cmd) don't need
  // it. POSIX keeps shell:false.
  const useShell = process.platform === "win32" && spec.cmd === "npm";
  const child = spawn(spec.cmd, spec.args, { shell: useShell, env: { ...process.env, PATH: widenedPath() } });
  const enc = new TextEncoder();
  let sawEacces = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let done = false;
      const push = (s: string) => { try { controller.enqueue(enc.encode(s)); } catch { /* closed */ } };
      const watch = (s: string) => { if (/EACCES|EPERM|permission denied/i.test(s)) sawEacces = true; return s; };
      const finish = (result: Result) => {
        if (done) return;
        done = true;
        push(`[result ${result}]\n`);
        controller.close();
      };
      push(`$ ${spec.cmd} ${spec.args.join(" ")}\n`);
      child.stdout.on("data", (d: Buffer) => push(watch(d.toString())));
      child.stderr.on("data", (d: Buffer) => push(watch(d.toString())));
      child.on("error", (e) => {
        push(`\n[error] ${e.message}\n`);
        if (spec.terminal) push(terminalHelp(spec.display));
        finish(spec.terminal ? "terminal_launch_failed" : "error");
      });
      child.on("close", (code) => {
        const eacces = spec.cmd === "npm" && code !== 0 && sawEacces;
        if (eacces) push(NPM_EACCES_HELP);
        if (spec.terminal && code !== 0) push(terminalHelp(spec.display));
        push(
          spec.terminal && code === 0
            ? "\n✓ Continues in the terminal window that opened. Finish there; the status updates by itself.\n"
            : `\n[exit ${code ?? 0}]\n`,
        );
        finish(spec.terminal ? (code === 0 ? "terminal_opened" : "terminal_launch_failed") : eacces ? "npm_eacces" : code === 0 ? "ok" : "failed");
      });
    },
    cancel() { child.kill(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" } });
}
