import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream } from "@zed-industries/agent-client-protocol";
import type { Client, RequestPermissionRequest, RequestPermissionResponse, SessionNotification, SessionModelState, SessionModeState } from "@zed-industries/agent-client-protocol";
import { getSetting } from "@openlive/db";
import type { Message } from "@openlive/harness";
import type { Emit } from "../tools.js";
import type { Agent, AgentId, AgentMeta, AskPermission, Posture, TurnInput } from "./types.js";

// Drive an external coding agent as the live brain over the Agent Client Protocol
// (JSON-RPC over LOCAL stdio — "LSP for agents"). We spawn the agent's ACP adapter
// as a child process and talk to it; nothing leaves the machine except what the
// agent itself sends to its OWN provider, under the user's OWN login. We advertise
// NO fs/terminal capabilities: a voice app isn't an editor, so the agent uses its
// own file access and asks us (via request_permission) before doing anything risky.

// Adapter command per agent. Overridable via a setting so an ecosystem package
// rename doesn't strand a user.
const ADAPTERS: Record<AgentId, { command: string; args: string[] }> = {
  "claude-code": { command: "npx", args: ["-y", "@zed-industries/claude-code-acp"] },
  "codex": { command: "npx", args: ["-y", "@zed-industries/codex-acp"] },
  "cursor": { command: "cursor-agent", args: ["acp"] },
};

// Auto-approvable tool kinds under the "auto-safe" posture — read-only, non-destructive.
const SAFE_KINDS = new Set(["read", "search", "fetch", "think"]);

// Sent once per session so the agent knows it's a spoken voice+vision call (not a
// terminal) and goes ALONG with it as itself — without ever faking capabilities.
const PREAMBLE = `[You're being used through OpenLive, a hands-free VOICE interface — not a terminal. The user is TALKING to you out loud: their speech is transcribed to text and sent as their messages, and your text replies are read back to them aloud with text-to-speech. So this is a real spoken conversation — the user hears you, and you're effectively hearing them through the transcription. When they turn on their camera or share their screen, the current frame is attached to their message as an image so you can actually see what they're showing.
Go along with this naturally: you're still yourself, doing your normal work, but talk in a spoken, conversational style — short natural sentences, no markdown or long code dumps unless they ask, describe what you'd do rather than pasting walls of text. Do NOT tell the user you "can't hear" or "can't see" them or that you're "just a text tool" — OpenLive bridges voice and vision for you, so that's simply false here. But never pretend or invent anything: if you genuinely didn't receive an image or can't make something out, say so plainly and ask.]`;

export interface AcpOpts {
  onSession?: (sessionId: string) => void;   // report the ACP session id (resume-later persistence)
  resumeSessionId?: string;                    // replay a prior session via session/load
  cwd?: string;                                // the project folder the agent runs in
  posture?: () => Posture;                     // how to handle permission requests
  onMeta?: (meta: AgentMeta) => void;          // the agent's available models/modes → UI
}

/** GUI-spawned processes get a skeletal PATH on macOS — the user's agent binaries
 *  (homebrew/npm) live outside it. Append the usual bins so `npx`/`cursor-agent` resolve. */
function widenedPath(): string {
  const extra = ["/usr/local/bin", "/opt/homebrew/bin", `${homedir()}/.local/bin`, `${homedir()}/bin`, `${homedir()}/.npm-global/bin`];
  const cur = (process.env.PATH ?? "").split(":");
  return [...cur, ...extra.filter((p) => !cur.includes(p))].join(":");
}

function adapterFor(id: AgentId, cwd?: string): { command: string; args: string[]; cwd: string } {
  const base = ADAPTERS[id];
  const override = getSetting(`acpCommand:${id}`)?.trim(); // e.g. "npx @agentclientprotocol/claude-agent-acp"
  const [cmd, ...args] = override ? override.split(/\s+/) : [base.command, ...base.args];
  return { command: cmd || base.command, args: override ? args : base.args, cwd: cwd?.trim() || getSetting("agentCwd")?.trim() || homedir() };
}

export class AcpAgent implements Agent {
  readonly id: AgentId;
  private child: ChildProcessWithoutNullStreams | null = null;
  private conn: ClientSideConnection | null = null;
  private sessionId = "";
  private seedText = "";
  private turnEmit: Emit | null = null;
  private alive = false;
  private supportsImages = false; // agent accepts image content blocks (camera/screen frames)
  private sentPreamble = false;   // the voice+vision context is sent once per session
  private meta: AgentMeta = { models: [], currentModelId: null, modes: [], currentModeId: null };

  constructor(id: AgentId, private askPermission: AskPermission, private opts: AcpOpts = {}) {
    this.id = id;
  }

  seed(history: Message[]) {
    const lines = history
      .map((m) => ("text" in m && m.text ? `${m.role === "user" ? "User" : "You"}: ${m.text}` : ""))
      .filter(Boolean);
    this.seedText = lines.length ? `[Context — earlier in this voice conversation:\n${lines.join("\n")}]\n\n` : "";
  }

  async start(_signal: AbortSignal): Promise<void> {
    const cfg = adapterFor(this.id, this.opts.cwd);
    const child = spawn(cfg.command, cfg.args, {
      cwd: cfg.cwd,
      env: { ...process.env, PATH: widenedPath() },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000); });

    // Reject the whole handshake if the child dies before it's ready. An OUTDATED or
    // SIGNED-OUT agent (e.g. an old cursor-agent) prints a TUI / exits instead of
    // speaking ACP — a clean, actionable error beats a 60s hang + JSON-parse spam.
    let ready = false;
    const died = new Promise<never>((_, reject) => {
      child.once("error", (e) => reject(new Error(`Couldn't run "${cfg.command}": ${e.message}. Is ${labelFor(this.id)} installed?`)));
      child.once("exit", (code) => {
        this.alive = false;
        if (!ready) reject(new Error(startError(this.id, code, stderr)));
        else if (code) console.error(`[agent:${this.id}] ${cfg.command} exited ${code}`);
      });
    });
    died.catch(() => {}); // no unhandled rejection if the handshake wins the race

    await Promise.race([new Promise<void>((r) => child.once("spawn", () => r())), died]);
    this.alive = true;

    const stream = ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    this.conn = new ClientSideConnection((_agent) => this.clientHandler(), stream);

    await Promise.race([this.handshake(cfg.cwd), died]);
    ready = true;
    this.opts.onSession?.(this.sessionId);
  }

  /** ACP handshake: initialize → resume (session/load) or new session, capturing
   *  image capability + the agent's models/modes. */
  private async handshake(cwd: string): Promise<void> {
    const init = await this.conn!.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    this.supportsImages = !!init.agentCapabilities?.promptCapabilities?.image;
    let resumed = false;
    if (this.opts.resumeSessionId) {
      try {
        const r = await this.conn!.loadSession({ sessionId: this.opts.resumeSessionId, cwd, mcpServers: [] });
        this.sessionId = this.opts.resumeSessionId;
        this.reportMeta(r);
        resumed = true;
      } catch { /* fall through to a fresh session */ }
    }
    if (!resumed) {
      const r = await this.conn!.newSession({ cwd, mcpServers: [] });
      this.sessionId = r.sessionId;
      this.reportMeta(r);
    }
  }

  /** Surface the agent's selectable models + modes (from session/new|load) to the UI. */
  private reportMeta(r: { models?: SessionModelState | null; modes?: SessionModeState | null }) {
    this.meta = {
      models: r.models?.availableModels.map((m) => ({ id: m.modelId, name: m.name })) ?? [],
      currentModelId: r.models?.currentModelId ?? null,
      modes: r.modes?.availableModes.map((m) => ({ id: m.id, name: m.name })) ?? [],
      currentModeId: r.modes?.currentModeId ?? null,
    };
    this.opts.onMeta?.(this.meta);
  }

  async setModel(modelId: string): Promise<void> {
    if (!this.conn || !this.sessionId) return;
    // Never throw: an agent that rejects a model id must not crash the session.
    try {
      await this.conn.setSessionModel({ sessionId: this.sessionId, modelId });
      this.meta = { ...this.meta, currentModelId: modelId };
      this.opts.onMeta?.(this.meta);
    } catch (e) { console.error(`[agent:${this.id}] setModel(${modelId}) failed:`, e); }
  }

  async setMode(modeId: string): Promise<void> {
    if (!this.conn || !this.sessionId) return;
    try {
      await this.conn.setSessionMode({ sessionId: this.sessionId, modeId });
      this.meta = { ...this.meta, currentModeId: modeId };
      this.opts.onMeta?.(this.meta);
    } catch (e) { console.error(`[agent:${this.id}] setMode(${modeId}) failed:`, e); }
  }

  /** ACP client surface: session updates → SseEvents; permission asks → the user. */
  private clientHandler(): Client {
    return {
      sessionUpdate: async (n: SessionNotification): Promise<void> => {
        const emit = this.turnEmit;
        if (!emit || n.sessionId !== this.sessionId) return;
        const u = n.update;
        switch (u.sessionUpdate) {
          case "agent_message_chunk":
            if (u.content.type === "text") await emit({ type: "text_delta", text: u.content.text });
            return;
          case "agent_thought_chunk":
            if (u.content.type === "text") await emit({ type: "reasoning_delta", text: u.content.text });
            return;
          case "tool_call": {
            // Include the file it touches (if any) so the transcript shows file changes.
            const path = u.locations?.[0]?.path;
            const label = u.title || u.kind || "tool";
            await emit({ type: "tool_start", id: u.toolCallId, tool: path ? `${label} · ${path}` : label });
            return;
          }
          case "tool_call_update":
            if (u.status === "completed" || u.status === "failed") await emit({ type: "tool_done", id: u.toolCallId, detail: u.status === "failed" ? "error" : undefined });
            return;
          case "plan":
            // The agent's evolving plan → the transcript's todo list.
            await emit({ type: "todos", items: u.entries.map((e) => ({ text: e.content, done: e.status === "completed" })) });
            return;
          case "current_mode_update":
            this.meta = { ...this.meta, currentModeId: u.currentModeId };
            this.opts.onMeta?.(this.meta);
            return;
          default:
            return; // user echoes, available_commands — nothing to render
        }
      },
      requestPermission: async (req: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        const byKind = (k: string) => req.options.find((o) => o.kind === k);
        const allow = byKind("allow_once");
        // Posture: auto-approve everything, auto-approve read-only ops, or always ask.
        const posture = this.opts.posture?.() ?? "ask";
        const kind = req.toolCall?.kind ?? "";
        if (allow && (posture === "auto-all" || (posture === "auto-safe" && SAFE_KINDS.has(kind)))) {
          return { outcome: { outcome: "selected", optionId: allow.optionId } };
        }
        // Otherwise map the options onto canonical allow/always/deny ids (the voice
        // yes/no classifier keys on these) and ask the user.
        const options: { id: string; label: string }[] = [];
        if (allow) options.push({ id: "allow", label: allow.name || "Allow" });
        const always = byKind("allow_always"); if (always) options.push({ id: "always", label: always.name || "Always allow" });
        const deny = byKind("reject_once") ?? byKind("reject_always"); if (deny) options.push({ id: "deny", label: deny.name || "Deny" });
        if (!options.length) return { outcome: { outcome: "cancelled" } };
        const title = req.toolCall?.title ? ` ${req.toolCall.title}.` : "";
        const choice = await this.askPermission(`${labelFor(this.id)} wants permission:${title} Allow it?`, options);
        const picked = choice === "allow" ? allow : choice === "always" ? always : deny;
        return picked ? { outcome: { outcome: "selected", optionId: picked.optionId } } : { outcome: { outcome: "cancelled" } };
      },
    };
  }

  async runTurn({ text, frames }: TurnInput, emit: Emit, signal: AbortSignal): Promise<void> {
    if (!this.conn || !this.alive) throw new Error(`${labelFor(this.id)} is not running`);
    if (signal.aborted) return;

    let userText = text;
    // Once per session, tell the agent it's in a spoken voice+vision call.
    if (!this.sentPreamble) { userText = `${PREAMBLE}\n\n${userText}`; this.sentPreamble = true; }
    // Note any live camera/screen the user is sharing (frames attached below when supported).
    const sources = frames.length ? [...new Set(frames.map((f) => f.source ?? "camera"))].join(" and ") : "";
    if (sources) {
      userText += this.supportsImages
        ? `\n\n[The user is sharing their ${sources} right now — the current view is attached below. Talk about what's actually there, naturally, as what you're both looking at.]`
        : `\n\n[The user is sharing their ${sources}, but you can't view images here — ask them to describe what they're showing.]`;
    }
    const body = this.seedText + userText;
    this.seedText = "";

    // Interleave the frames as image blocks so the agent sees the camera/screen.
    const prompt: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [{ type: "text", text: body }];
    if (this.supportsImages) for (const f of frames) prompt.push({ type: "image", data: f.data, mimeType: f.mime });

    this.turnEmit = emit;
    const onAbort = () => { void this.conn?.cancel({ sessionId: this.sessionId }).catch(() => {}); };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await this.conn.prompt({ sessionId: this.sessionId, prompt });
      if (res.stopReason === "refusal") await emit({ type: "error", message: `${labelFor(this.id)} refused this request.` });
    } catch (e) {
      if (signal.aborted) return; // barge-in / cancel — not an error
      // A JSON-RPC error RESPONSE means the agent is alive but rejected the turn
      // (e.g. an outdated Codex hitting a model its backend won't allow). Surface
      // the REAL, actionable message instead of a generic "crashed"; don't recycle.
      if (typeof (e as { code?: unknown } | null)?.code === "number") {
        await emit({ type: "error", message: `${labelFor(this.id)}: ${extractAcpError(e)}` });
      } else {
        throw e; // transport failure / agent died → let the supervisor recycle it
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (this.turnEmit === emit) this.turnEmit = null;
    }
  }

  health() { return this.alive ? { ok: true } : { ok: false, detail: `${labelFor(this.id)} process is not running` }; }

  async dispose(): Promise<void> {
    this.alive = false;
    this.turnEmit = null;
    try { this.child?.kill("SIGTERM"); } catch { /* already dead */ }
    this.child = null;
    this.conn = null;
  }
}

function labelFor(id: AgentId): string { return id === "claude-code" ? "Claude Code" : id === "codex" ? "Codex" : "Cursor"; }

/** Pull a human-readable message out of an ACP/JSON-RPC error — agents often nest
 *  the provider's real error JSON inside `data.message` (e.g. Codex's model/version
 *  rejection hidden under a generic "Internal error"). */
function extractAcpError(e: unknown): string {
  const err = e as { message?: string; data?: { message?: string } } | null;
  const raw = typeof err?.data?.message === "string" ? err.data.message
    : typeof err?.message === "string" ? err.message : String(e);
  try {
    const j = JSON.parse(raw) as { error?: { message?: string }; message?: string };
    const inner = j?.error?.message ?? j?.message;
    if (typeof inner === "string" && inner.trim()) return inner.trim();
  } catch { /* not JSON — use raw */ }
  return raw;
}

/** A clean, actionable error when an agent process dies before the ACP handshake. */
function startError(id: AgentId, code: number | null, stderr: string): string {
  const tail = stderr.trim().split("\n").filter(Boolean).slice(-2).join(" ").slice(-240);
  const hint = id === "cursor"
    ? "Its CLI may be outdated (needs ACP support) or signed out — update Cursor, then run `cursor-agent login`."
    : id === "codex"
      ? "Make sure `codex` is installed and signed in (run `codex`)."
      : "Make sure Claude Code is installed and signed in (run `claude`).";
  return `${labelFor(id)} exited before connecting${code != null ? ` (code ${code})` : ""}. ${hint}${tail ? ` — ${tail}` : ""}`;
}
