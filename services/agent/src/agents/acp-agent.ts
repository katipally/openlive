import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { statSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { Client, RequestPermissionRequest, RequestPermissionResponse, SessionNotification, SessionUpdate, SessionModeState, SessionConfigOption } from "@agentclientprotocol/sdk";
import { getSetting } from "@openlive/db";
import type { Message } from "@openlive/harness";
import {
  AGENT_REGISTRY, agentLabel as labelFor, capRawJson, capToolContent, mergeToolCall, toolKindSchema,
  type MessageBlock, type ToolCallDelta, type ToolCallState, type ToolContent, type ToolKind, type ToolLocation,
} from "@openlive/shared";
import { widenedPath } from "@openlive/shared/node";
import type { Emit } from "../tools.js";
import type { Agent, AgentId, AgentMeta, AskPermission, ReplayMessage, TurnInput } from "./types.js";
import { PERMISSION_CANCELLED } from "./types.js";
import { TerminalManager } from "./terminal-manager.js";
import { killTree } from "./proc.js";
import { readProjectMcpServers } from "./mcp-config.js";
import { log } from "../log.js";

// Drive an external coding agent as the live brain over the Agent Client Protocol
// (JSON-RPC over LOCAL stdio — "LSP for agents"). We spawn the agent's ACP adapter
// as a child process and talk to it; nothing leaves the machine except what the
// agent itself sends to its OWN provider, under the user's OWN login. We advertise
// NO fs/terminal capabilities: a voice app isn't an editor, so the agent uses its
// own file access and asks us (via request_permission) before doing anything risky.
//
// Which adapter each agent uses (and the claude version PIN OpenLive relies
// on) lives in the shared AGENT_REGISTRY; overridable per-agent via the
// `acpCommand:<id>` setting so an ecosystem package rename doesn't strand a user.

// Sent once per session so the agent knows it's a spoken voice+vision call (not a
// terminal) and goes ALONG with it as itself — without ever faking capabilities.
const PREAMBLE = `[You're being used through OpenLive, a hands-free VOICE interface — not a terminal. The user is TALKING to you out loud: their speech is transcribed to text and sent as their messages, and your text replies are read back to them aloud with text-to-speech. So this is a real spoken conversation — the user hears you, and you're effectively hearing them through the transcription. When they turn on their camera or share their screen, the current frame is attached to their message as an image so you can actually see what they're showing.
Go along with this naturally: you're still yourself, doing your normal work, but talk the way people talk on a call. Keep replies to a sentence or two unless they ask for more — spoken words take time, and a paragraph you'd happily type is a monologue out loud. No markdown, no lists, no code dumps. NEVER speak file paths, filenames, URLs, code, or stray symbols out loud — read by a voice they're nonsense ("src slash components slash button dot tsx"). Describe code and changes in plain words instead — "added a helper in the config file", "renamed that function", "fixed the login page". If they need the exact name, path, or code, tell them it's on their screen: the file names, diffs and commands show on the tool cards right in front of them. Give one short opening line if it helps ("let me take a look"), then work quietly — don't narrate each tool run or step; the user sees your work on the cards, and you'll tell them the result at the end. Do NOT tell the user you "can't hear" or "can't see" them or that you're "just a text tool" — OpenLive bridges voice and vision for you, so that's simply false here. But never pretend or invent anything: if you genuinely didn't receive an image or can't make something out, say so plainly and ask.]`;

/** The session preamble: the fixed voice-call context plus the user's own
 *  instructions from Settings → General, read fresh per session so an edit
 *  applies to the next call. Shared by every agent (Claude via system-prompt
 *  append, the rest via the first user message). */
export function preamble(): string {
  const custom = getSetting("customInstructions")?.trim().slice(0, 2000);
  if (!custom) return PREAMBLE;
  return `${PREAMBLE}\n[How the user wants you to behave and speak, in their own words — follow within reason:\n${custom}]`;
}

// Claude's adapter accepts Agent-SDK options via `_meta.claudeCode.options` on
// session/new AND session/load. Two things ride on it:
//   • persistSession — belt-and-braces so OpenLive sessions ALWAYS land in
//     ~/.claude/projects/<cwd-slug>/ where `claude --resume` finds them.
//   • systemPrompt append — the voice-call context goes into the system prompt
//     instead of polluting the first user message of the saved transcript.
// Other agents have no such channel, so they keep the first-turn preamble.
const buildClaudeMeta = () => ({
  claudeCode: {
    options: {
      persistSession: true,
      systemPrompt: { type: "preset", preset: "claude_code", append: preamble() },
    },
  },
});

export interface AcpOpts {
  onSession?: (sessionId: string) => void;   // report the ACP session id (resume-later persistence)
  resumeSessionId?: string;                    // replay a prior session via session/load
  cwd?: string;                                // the project folder the agent runs in
  onMeta?: (meta: AgentMeta) => void;          // the agent's available models/modes → UI
  onReplay?: (messages: ReplayMessage[]) => void; // prior turns recovered from session/load
  askElicitation?: (req: { mode: "url" | "form"; message: string; url?: string; schema?: unknown; elicitationId?: string }) => Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }>;
  completeElicitation?: (elicitationId: string) => void; // URL elicitation finished agent-side
}

function adapterFor(id: AgentId, cwd?: string): { command: string; args: string[]; cwd: string } {
  const base = AGENT_REGISTRY[id].adapter;
  const override = getSetting(`acpCommand:${id}`)?.trim(); // e.g. "npx @agentclientprotocol/claude-agent-acp"
  const [cmd, ...args] = override ? override.split(/\s+/) : [base.command, ...base.args];
  // No $HOME fallback: agents file sessions per-project, so an unset folder would
  // strand the session under the home bucket, invisible to `claude --resume` run
  // in the real project. Empty here → start() throws a clear "pick a folder".
  return { command: cmd || base.command, args: override ? args : base.args, cwd: cwd?.trim() || getSetting("agentCwd")?.trim() || "" };
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
  private meta: AgentMeta = { models: [], currentModelId: null, modes: [], currentModeId: null, options: [], resumeAcrossRestart: true };
  private modelConfigId: string | null = null; // the ACP config option id for model selection
  private replaying = false;      // inside a session/load: fold updates into the replay buffer
  private replay: ReplayMessage[] = []; // prior turns recovered from session/load replay
  private turnTools = new Map<string, ToolCallState>(); // this turn's tool calls, by id (cleared per turn)
  private terminals = new TerminalManager({
    cwd: () => adapterFor(this.id, this.opts.cwd).cwd,
    emit: () => this.turnEmit,
  });

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
    // A real project folder is required: it's where the agent files its session
    // (so `claude --resume` etc. can reopen it) and the only place it reads/writes.
    if (!cfg.cwd) throw new Error(`Pick a project folder for ${labelFor(this.id)} — it's where its sessions live and the only place it can read and write.`);
    // Spawning into a missing directory fails as a baffling "spawn npx ENOENT"
    // that reads like the agent isn't installed — name the real problem instead.
    try { if (!statSync(cfg.cwd).isDirectory()) throw new Error("not a directory"); }
    catch { throw new Error(`The project folder ${cfg.cwd} doesn't exist — pick a different one.`); }
    const isWin = process.platform === "win32";
    const child = spawn(cfg.command, cfg.args, {
      cwd: cfg.cwd,
      // Windows: npx/npm/uvx/opencode are `.cmd`/`.ps1` shims that Node's spawn
      // refuses to exec without a shell (ENOENT) — so bind Claude Code/Codex/OpenCode
      // died on Windows. Run through a shell there. On POSIX we keep shell:false so
      // the acpCommand override can't be shell-interpreted (validated + no shell).
      shell: isWin,
      env: {
        ...process.env,
        PATH: widenedPath(),
        // Per-agent env quirks live in the registry. Claude's entry:
        // CLAUDE_CODE_ENTRYPOINT="claude-vscode" — the CLI's /resume picker HIDES
        // sessions stamped with an SDK entrypoint, and "claude-vscode" is the
        // "IDE front-end sharing sessions with the CLI" contract, so OpenLive
        // sessions show in /resume and are genuinely shared both ways
        // (verified 2026-07-15 against claude 2.1.198 / adapter 0.59.0).
        ...(AGENT_REGISTRY[this.id].acp.env ?? {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      // POSIX: own process group so dispose() can kill the WHOLE tree. The adapter is
      // `npx …`/`npm exec …`, which spawns node → the real acp binary two levels
      // down; killing just our direct child orphans those grandchildren (they
      // reparent to init and leak). Group-kill (process.kill(-pid)) takes them all.
      // Windows has no process groups this way — dispose() uses `taskkill /T` instead.
      detached: !isWin,
    });
    this.child = child;
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000); });

    // Reject the whole handshake if the child dies before it's ready. An OUTDATED or
    // SIGNED-OUT agent (e.g. an old cursor-agent) prints a TUI / exits instead of
    // speaking ACP — a clean, actionable error beats a 60s hang + JSON-parse spam.
    let ready = false;
    let exitCode: number | null = null;
    const died = new Promise<never>((_, reject) => {
      child.once("error", (e) => reject(new Error(`Couldn't run "${cfg.command}": ${e.message}. Is ${labelFor(this.id)} installed?`)));
      child.once("exit", (code) => {
        this.alive = false;
        exitCode = code;
        if (!ready) reject(new Error(startError(this.id, code, stderr)));
        else if (code) log.error(`agent:${this.id}`, `${cfg.command} exited ${code}`);
      });
    });
    died.catch(() => {}); // no unhandled rejection if the handshake wins the race

    await Promise.race([new Promise<void>((r) => child.once("spawn", () => r())), died]);
    this.alive = true;

    const stream = ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    this.conn = new ClientSideConnection((_agent) => this.clientHandler(), stream);

    try {
      await Promise.race([this.handshake(cfg.cwd), died]);
    } catch (e) {
      // The SDK's "ACP connection closed" (stdout ended) outruns the child's `exit`
      // event — give the exit a moment, and if the child is dead tell the actionable
      // story (exit + stderr + per-agent hint), not the transport's.
      const dead = await Promise.race([died.catch(() => true), new Promise<false>((r) => setTimeout(() => r(false), 500))]);
      throw dead || !this.alive ? new Error(startError(this.id, exitCode, stderr)) : e;
    }
    ready = true;
    this.opts.onSession?.(this.sessionId);
  }

  /** ACP handshake: initialize → resume (session/load) or new session, capturing
   *  image capability + the agent's models/modes. Resume is capability-gated; a
   *  failure falls back to a fresh session SILENTLY (see below — resume-fail is a
   *  common, benign case, and the original session stays on disk / in History). */
  private async handshake(cwd: string): Promise<void> {
    const init = await this.conn!.initialize({
      protocolVersion: PROTOCOL_VERSION,
      // fs stays false by design (no editor = no unsaved buffers to serve), but
      // we DO host terminals (registry-gated per agent): commands run through
      // OpenLive, so output streams live into the tool card and cancel actually
      // kills the process tree.
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: AGENT_REGISTRY[this.id].acp.terminal,
        // Elicitations: login/OAuth URLs open the user's browser (narrated); form
        // requests render a proper modal. Both fully handled in clientHandler().
        elicitation: { url: {}, form: {} },
      },
    });
    this.supportsImages = !!init.agentCapabilities?.promptCapabilities?.image;
    const canLoad = !!init.agentCapabilities?.loadSession;
    const quirks = AGENT_REGISTRY[this.id].acp;
    // Claude gets the voice context through its system prompt (buildClaudeMeta), so the
    // first user message stays clean; everyone else gets the PREAMBLE prepended.
    const meta = quirks.preamble === "systemPrompt" ? buildClaudeMeta() : undefined;
    if (meta) this.sentPreamble = true;
    this.meta = { ...this.meta, resumeAcrossRestart: canLoad && quirks.resumeAcrossRestart };
    // MCP passthrough: the project's own .mcp.json rides along for agents that
    // don't read it themselves ("native" agents would double-register).
    const mcpServers = quirks.mcp === "passthrough" ? readProjectMcpServers(cwd, init) : [];

    let resumed = false;
    // Resume the chat's own prior session when the agent can. A failure here is
    // EXPECTED and benign — an empty/never-persisted session (e.g. a lobby prewarm
    // that made a session but never took a turn), a stale id, or a mid-call
    // reconnect — so we fall back to a fresh session SILENTLY. The original session
    // stays on disk and is still resumable from History. (Surfacing this as a spoken
    // notice made every normal reopen blurt out "couldn't reopen…".)
    if (this.opts.resumeSessionId && canLoad) {
      // Match replay updates (which stream DURING the load, before this.sessionId
      // would otherwise be set) by stamping the id up front.
      this.sessionId = this.opts.resumeSessionId;
      this.replaying = true;
      try {
        const r = await this.conn!.loadSession({ sessionId: this.opts.resumeSessionId, cwd, mcpServers, ...(meta ? { _meta: meta } : {}) });
        this.replaying = false;
        this.reportMeta(r);
        resumed = true;
        // The agent restored the FULL conversation itself — drop our text recap
        // so the first turn isn't prefixed with a redundant "[Context — earlier…]".
        this.seedText = "";
        // Dead turns can't finish their calls — a replayed "in_progress" would
        // spin forever in the transcript. Settle to canceled before ingest.
        for (const m of this.replay) {
          for (let j = 0; j < m.content.length; j++) {
            const b = m.content[j]!;
            if (b.type === "acp_tool" && (b.call.status === "pending" || b.call.status === "in_progress")) {
              m.content[j] = { type: "acp_tool", call: { ...b.call, status: "canceled" } };
            }
          }
        }
        if (this.replay.length) this.opts.onReplay?.(this.replay);
      } catch (e) {
        log.debug(`agent:${this.id}`, `resume failed (${extractAcpError(e)}) — starting fresh`);
      } finally {
        this.replaying = false;
        this.replay = [];
      }
    }
    if (!resumed) {
      const r = await this.conn!.newSession({ cwd, mcpServers, ...(meta ? { _meta: meta } : {}) });
      this.sessionId = r.sessionId;
      this.reportMeta(r);
    }
  }

  /** Surface the agent's modes + config options (from session/new|load) to the UI. */
  private reportMeta(r: { modes?: SessionModeState | null; configOptions?: SessionConfigOption[] | null }) {
    if (r.modes) {
      this.meta = { ...this.meta, modes: r.modes.availableModes.map((m) => ({ id: m.id, name: m.name })), currentModeId: r.modes.currentModeId ?? null };
    }
    this.applyConfig(r.configOptions);
    this.opts.onMeta?.(this.meta);
  }

  /** Fold ACP session config options into meta: the `model` category drives the
   *  model picker; every other select (thought/reasoning level, model config, …)
   *  becomes a generic option the UI renders as its own dropdown.
   *  NOTE: `mode` is EXCLUDED here — every agent (Claude/Codex/Cursor) reports mode
   *  through BOTH `SessionModeState` (the dedicated mode picker + setSessionMode) AND
   *  a `category:"mode"` config option. Surfacing both renders "Mode" twice, so we
   *  keep only the dedicated picker and drop the duplicate config option. */
  private applyConfig(configOptions?: SessionConfigOption[] | null): void {
    const selects = (configOptions ?? []).filter((o): o is Extract<SessionConfigOption, { type: "select" }> => o.type === "select");
    const modelOpt = selects.find((o) => o.category === "model");
    this.modelConfigId = modelOpt?.id ?? null;
    this.meta = {
      ...this.meta,
      models: modelOpt ? flattenSelect(modelOpt.options) : this.meta.models,
      currentModelId: modelOpt ? (modelOpt.currentValue ?? null) : this.meta.currentModelId,
      options: selects.filter((o) => o.category !== "model" && o.category !== "mode").map((o) => ({
        id: o.id, label: o.name, category: o.category ?? "", values: flattenSelect(o.options), currentId: o.currentValue ?? null,
      })),
    };
  }

  async setModel(modelId: string): Promise<void> {
    if (!this.conn || !this.sessionId || !this.modelConfigId) return;
    // Model selection is now an ACP session config option. Never throw: an agent
    // that rejects a value must not crash the session.
    try {
      // The response carries the FULL new config state (changing one option can
      // affect others) — fold it in rather than optimistically patching one field.
      const res = await this.conn.setSessionConfigOption({ sessionId: this.sessionId, configId: this.modelConfigId, value: modelId });
      if (res?.configOptions) this.applyConfig(res.configOptions);
      else this.meta = { ...this.meta, currentModelId: modelId };
      this.opts.onMeta?.(this.meta);
    } catch (e) { log.error(`agent:${this.id}`, `setModel(${modelId}) failed:`, e); }
  }

  async setMode(modeId: string): Promise<void> {
    if (!this.conn || !this.sessionId) return;
    try {
      await this.conn.setSessionMode({ sessionId: this.sessionId, modeId });
      this.meta = { ...this.meta, currentModeId: modeId };
      this.opts.onMeta?.(this.meta);
    } catch (e) { log.error(`agent:${this.id}`, `setMode(${modeId}) failed:`, e); }
  }

  /** Set any other ACP session config option (thought/reasoning level, model config…). */
  async setOption(optionId: string, valueId: string): Promise<void> {
    if (!this.conn || !this.sessionId) return;
    try {
      const res = await this.conn.setSessionConfigOption({ sessionId: this.sessionId, configId: optionId, value: valueId });
      if (res?.configOptions) this.applyConfig(res.configOptions);
      else this.meta = { ...this.meta, options: this.meta.options.map((o) => (o.id === optionId ? { ...o, currentId: valueId } : o)) };
      this.opts.onMeta?.(this.meta);
    } catch (e) { log.error(`agent:${this.id}`, `setOption(${optionId}=${valueId}) failed:`, e); }
  }

  /** ACP client surface: session updates → SseEvents; permission asks → the user. */
  private clientHandler(): Client {
    return {
      sessionUpdate: async (n: SessionNotification): Promise<void> => {
        if (n.sessionId !== this.sessionId) return;
        const u = n.update;
        // During a session/load the agent replays the WHOLE prior conversation as
        // updates before responding — with no turn active. Fold them into the replay
        // buffer (→ transcript) instead of dropping them. Mode/config updates that
        // stream during the load are SESSION STATE, not transcript — apply them to
        // meta (reportMeta emits it after the load), or resumed sessions lose their
        // model/mode pickers while fresh ones keep them.
        if (this.replaying) {
          if (u.sessionUpdate === "current_mode_update") { this.meta = { ...this.meta, currentModeId: u.currentModeId }; return; }
          if (u.sessionUpdate === "config_option_update") { this.applyConfig(u.configOptions); return; }
          this.bufferReplay(u); return;
        }

        // Turn-independent updates (mode / config) arrive any time, including
        // outside a turn — handle them without an emit.
        switch (u.sessionUpdate) {
          case "current_mode_update":
            this.meta = { ...this.meta, currentModeId: u.currentModeId };
            this.opts.onMeta?.(this.meta);
            return;
          case "config_option_update":
            // A model/thought-level/… selection landed (ours or the agent's own).
            this.applyConfig(u.configOptions);
            this.opts.onMeta?.(this.meta);
            return;
          case "available_commands_update":
            // Slash commands proved unusable for a voice UI (tried twice, removed) —
            // the agent still interprets a spoken "/review" fine on its own.
            return;
        }

        // The rest belong to an in-flight turn; without one there's nothing to render.
        const emit = this.turnEmit;
        if (!emit) return;
        switch (u.sessionUpdate) {
          case "agent_message_chunk":
            if (u.content.type === "text") await emit({ type: "text_delta", text: u.content.text });
            return;
          case "agent_thought_chunk":
            if (u.content.type === "text") await emit({ type: "reasoning_delta", text: u.content.text });
            return;
          case "tool_call": {
            // Full snapshot: title, kind, 4-state status, content (text/diff/
            // terminal), locations, raw input/output — nothing dropped anymore.
            const call: ToolCallState = {
              id: u.toolCallId,
              title: u.title || u.kind || "tool",
              kind: toToolKind(u.kind),
              status: u.status ?? "pending",
              content: contentFromAcp(u.content),
              locations: locationsFromAcp(u.locations),
              rawInputJson: rawJson(u.rawInput),
              rawOutputJson: rawJson(u.rawOutput),
            };
            this.turnTools.set(call.id, call);
            await emit({ type: "acp_tool_call", call });
            return;
          }
          case "tool_call_update": {
            const delta = deltaFromAcp(u);
            this.turnTools.set(u.toolCallId, mergeToolCall(this.turnTools.get(u.toolCallId), delta));
            await emit({ type: "acp_tool_update", delta });
            return;
          }
          case "plan":
            // The agent's evolving plan → the transcript's todo list.
            await emit({ type: "todos", items: u.entries.map((e) => ({ text: e.content, done: e.status === "completed" })) });
            return;
          case "plan_removed":
            await emit({ type: "todos", items: [] });
            return;
          case "usage_update":
            // Context/cost meter. ACP usage_update has no output-token count —
            // omit the field rather than fabricate a 0; `size` drives a real
            // used/size context meter in the UI.
            await emit({ type: "usage", contextTokens: u.used, contextSize: u.size, costUsd: u.cost?.amount ?? 0 });
            return;
          default:
            return; // user echoes, plan_update (unstable) — nothing to render
        }
      },
      requestPermission: async (req: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        // The agent only asks when its own ACP mode requires it (the user picks that
        // mode before the call — e.g. "always ask" vs "accept edits" vs "bypass"), so
        // OpenLive just relays the ask. ALL options pass through with their real
        // optionId + kind (allows first, rejects last); the client uses kind for
        // voice yes/no mapping + styling, and toolCallId interleaves the ask on
        // that tool's card in the activity panel.
        const KINDS = ["allow_once", "allow_always", "reject_once", "reject_always"] as const;
        const isKind = (k: unknown): k is (typeof KINDS)[number] => KINDS.includes(k as never);
        const byKind = (k: string) => req.options.find((o) => o.kind === k);
        const options = [...req.options]
          .sort((a, b) => KINDS.indexOf(a.kind as never) - KINDS.indexOf(b.kind as never))
          .map((o) => ({ id: o.optionId, label: o.name || o.optionId, kind: isKind(o.kind) ? o.kind : undefined }));
        if (!options.length) return { outcome: { outcome: "cancelled" } };
        const toolCallId = req.toolCall?.toolCallId;
        const title = req.toolCall?.title ? ` ${req.toolCall.title}.` : "";
        const choice = await this.askPermission(`${labelFor(this.id)} wants permission:${title} Allow it?`, options, toolCallId);
        // Barge-in / interrupt resolves any pending ask with this sentinel — ACP
        // requires the client to answer in-flight permission requests as cancelled.
        if (choice === PERMISSION_CANCELLED) {
          if (toolCallId) await this.settleToolStatus(toolCallId, "canceled");
          return { outcome: { outcome: "cancelled" } };
        }
        // The chosen id is normally the ACP optionId verbatim; the timeout path and
        // voice fallbacks may still answer canonical "allow"/"always"/"deny".
        const picked = req.options.find((o) => o.optionId === choice)
          ?? (choice === "allow" ? byKind("allow_once")
            : choice === "always" ? byKind("allow_always")
            : choice === "deny" ? (byKind("reject_once") ?? byKind("reject_always")) : undefined);
        if (!picked) return { outcome: { outcome: "cancelled" } };
        // A denial settles the card immediately (Zed parity); if the agent follows
        // up with its own status update, the later merge simply wins.
        if (toolCallId && String(picked.kind).startsWith("reject")) await this.settleToolStatus(toolCallId, "rejected");
        return { outcome: { outcome: "selected", optionId: picked.optionId } };
      },

      // ── client-hosted terminals (terminal/*) ────────────────────────────
      createTerminal: async (p) => {
        this.assertSession(p.sessionId);
        return this.terminals.create(p);
      },
      terminalOutput: async (p) => {
        this.assertSession(p.sessionId);
        return this.terminals.output(p.terminalId);
      },
      waitForTerminalExit: async (p) => {
        this.assertSession(p.sessionId);
        const exit = await this.terminals.waitForExit(p.terminalId);
        return { exitCode: exit.exitCode, signal: exit.signal };
      },
      killTerminal: async (p) => {
        this.assertSession(p.sessionId);
        this.terminals.kill(p.terminalId);
      },
      releaseTerminal: async (p) => {
        this.assertSession(p.sessionId);
        this.terminals.release(p.terminalId);
      },

      // ── elicitations (unstable): login URLs + input forms ────────────────
      unstable_createElicitation: async (req) => {
        const ask = this.opts.askElicitation;
        if (!ask) return { action: "decline" };
        // The union's custom-mode arm ({mode: string}) defeats TS narrowing —
        // read the mode-specific fields structurally instead.
        const r = req as { mode: string; message: string; url?: string; elicitationId?: unknown; requestedSchema?: unknown };
        if (r.mode === "url" && typeof r.url === "string") {
          return ask({ mode: "url", message: r.message, url: r.url, elicitationId: String(r.elicitationId ?? "") || undefined });
        }
        if (r.mode === "form" && r.requestedSchema) {
          return ask({ mode: "form", message: r.message, schema: r.requestedSchema });
        }
        return { action: "decline" }; // unknown future mode — refuse cleanly, never hang
      },
      unstable_completeElicitation: async (n) => {
        // The agent noticed the URL flow finished (OAuth landed) — settle our card.
        this.opts.completeElicitation?.(String(n.elicitationId));
      },
    };
  }

  /** Terminal calls for a session we don't own are protocol errors, not silence. */
  private assertSession(sessionId: string): void {
    if (sessionId !== this.sessionId) throw new Error(`unknown session: ${sessionId}`);
  }

  /** Fold one replayed session/load update into the recovered-message buffer,
   *  merging consecutive same-role chunks into a single message. Tool calls
   *  replay RICH (kind/status/diffs/raw input), so a resumed session's history
   *  renders exactly like it did live. Capped to the newest 200 messages —
   *  external sessions can be huge. (No optimistic-user-message dedup needed:
   *  replay is only ever ingested into an EMPTY chat, see ingestReplay.) */
  private bufferReplay(u: SessionUpdate): void {
    const add = (role: "user" | "assistant", block: MessageBlock) => {
      const last = this.replay[this.replay.length - 1];
      if (last && last.role === role) appendBlock(last.content, block);
      else {
        this.replay.push({ role, content: [block] });
        if (this.replay.length > 200) this.replay.shift();
      }
    };
    switch (u.sessionUpdate) {
      case "user_message_chunk":
        if (u.content.type === "text") add("user", { type: "text", text: u.content.text });
        return;
      case "agent_message_chunk":
        if (u.content.type === "text") add("assistant", { type: "text", text: u.content.text });
        return;
      case "agent_thought_chunk":
        if (u.content.type === "text") add("assistant", { type: "reasoning", text: u.content.text });
        return;
      case "tool_call":
        add("assistant", {
          type: "acp_tool",
          call: {
            id: u.toolCallId,
            title: u.title || u.kind || "tool",
            kind: toToolKind(u.kind),
            status: u.status ?? "pending",
            content: contentFromAcp(u.content),
            locations: locationsFromAcp(u.locations),
            rawInputJson: rawJson(u.rawInput),
            rawOutputJson: rawJson(u.rawOutput),
          },
        });
        return;
      case "tool_call_update": {
        // Merge into the already-replayed call (scan from the end). An update
        // for a call we never replayed isn't history worth inventing — drop it.
        const delta = deltaFromAcp(u);
        for (let i = this.replay.length - 1; i >= 0; i--) {
          const content = this.replay[i]!.content;
          for (let j = content.length - 1; j >= 0; j--) {
            const b = content[j]!;
            if (b.type === "acp_tool" && b.call.id === delta.id) {
              content[j] = { type: "acp_tool", call: mergeToolCall(b.call, delta) };
              return;
            }
          }
        }
        return;
      }
      default:
        return; // plans/usage/etc. aren't part of the recovered transcript
    }
  }

  /** Settle a tool card's status from the client side (permission denied /
   *  cancelled) — emitted as a normal delta so every layer folds it identically. */
  private async settleToolStatus(toolCallId: string, status: "canceled" | "rejected"): Promise<void> {
    const emit = this.turnEmit;
    if (!emit) return;
    const delta = { id: toolCallId, status } as const;
    this.turnTools.set(toolCallId, mergeToolCall(this.turnTools.get(toolCallId), delta));
    await emit({ type: "acp_tool_update", delta });
  }

  async runTurn({ text, frames }: TurnInput, emit: Emit, signal: AbortSignal): Promise<void> {
    if (!this.conn || !this.alive) throw new Error(`${labelFor(this.id)} is not running`);
    if (signal.aborted) return;

    let userText = text;
    // Once per session, tell the agent it's in a spoken voice+vision call.
    if (!this.sentPreamble) { userText = `${preamble()}\n\n${userText}`; this.sentPreamble = true; }
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
    const onAbort = () => {
      void this.conn?.cancel({ sessionId: this.sessionId }).catch(() => {});
      // Barge-in kills running commands too — a canceled turn must not leave a
      // test suite churning. Buffers stay valid for late terminal/output reads.
      this.terminals.killAll();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      // Awaiting the prompt also waits out a barge-in: after we send session/cancel
      // the agent still resolves this with stopReason "cancelled" (per spec), so the
      // turn is fully settled before the finally drains the next utterance.
      const res = await this.conn.prompt({ sessionId: this.sessionId, prompt });
      switch (res.stopReason) {
        case "refusal": await emit({ type: "error", message: `${labelFor(this.id)} refused this request.` }); break;
        case "max_tokens": await emit({ type: "text_delta", text: " …(I hit the response length limit — say “continue” to keep going.)" }); break;
        case "max_turn_requests": await emit({ type: "text_delta", text: " …(I hit my step limit for this turn — say “continue” to keep going.)" }); break;
        default: break; // end_turn, cancelled — nothing extra to say
      }
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
      this.turnTools.clear(); // per-turn state — never accumulates across turns
    }
  }

  async dispose(): Promise<void> {
    this.alive = false;
    this.turnEmit = null;
    this.terminals.disposeAll(); // hosted commands die with the session
    const child = this.child;
    this.child = null;
    this.conn = null;
    // Kill the adapter's whole process tree (npx → node → acp binary) so
    // grandchildren don't leak — POSIX process group / Windows taskkill /T.
    if (child) killTree(child);
  }
}

/** Append a replayed block, merging into the trailing text/reasoning block of the
 *  same kind so streamed chunks read as one message (not one bubble per token). */
export function appendBlock(content: MessageBlock[], block: MessageBlock): void {
  const last = content[content.length - 1];
  if (block.type === "text" && last?.type === "text") { last.text += block.text; return; }
  if (block.type === "reasoning" && last?.type === "reasoning") { last.text += block.text; return; }
  content.push(block);
}

// ── ACP → shared tool-call converters ──────────────────────────────────────
const toToolKind = (k: unknown): ToolKind => (toolKindSchema.safeParse(k).success ? (k as ToolKind) : "other");

/** Convert ACP tool-call content into the shared wire shape, applying the
 *  emit-time size caps. Non-text content blocks (images/resources inside a
 *  "content" item) have no voice-app rendering — skipped. */
function contentFromAcp(items: unknown[] | null | undefined): ToolContent[] {
  const out: ToolContent[] = [];
  for (const raw of items ?? []) {
    const c = raw as { type?: string; content?: { type?: string; text?: string }; path?: string; oldText?: string | null; newText?: string; terminalId?: string };
    if (c.type === "content" && c.content?.type === "text" && typeof c.content.text === "string") {
      out.push(capToolContent({ type: "text", text: c.content.text }));
    } else if (c.type === "diff" && typeof c.path === "string" && typeof c.newText === "string") {
      out.push(capToolContent({ type: "diff", path: c.path, oldText: c.oldText ?? undefined, newText: c.newText }));
    } else if (c.type === "terminal" && typeof c.terminalId === "string") {
      out.push({ type: "terminal", terminalId: c.terminalId });
    }
  }
  return out;
}

const locationsFromAcp = (locs: Array<{ path: string; line?: number | null }> | null | undefined): ToolLocation[] =>
  (locs ?? []).map((l) => ({ path: l.path, line: l.line ?? undefined }));

/** rawInput/rawOutput are arbitrary JSON — stringify + cap for the wire. */
const rawJson = (v: unknown): string | undefined => {
  if (v == null) return undefined;
  try { return capRawJson(JSON.stringify(v)); } catch { return undefined; }
};

/** Normalize an ACP tool_call_update into a sparse shared delta — ACP uses
 *  null/absent for "unchanged" (Zed parity). Shared by the live and replay paths. */
function deltaFromAcp(u: {
  toolCallId: string; title?: string | null; kind?: string | null; status?: "pending" | "in_progress" | "completed" | "failed" | null;
  content?: unknown[] | null; locations?: Array<{ path: string; line?: number | null }> | null; rawInput?: unknown; rawOutput?: unknown;
}): ToolCallDelta {
  const delta: ToolCallDelta = { id: u.toolCallId };
  if (u.title != null) delta.title = u.title;
  if (u.kind != null) delta.kind = toToolKind(u.kind);
  if (u.status != null) delta.status = u.status;
  if (u.content != null) delta.content = contentFromAcp(u.content);
  if (u.locations != null) delta.locations = locationsFromAcp(u.locations);
  if (u.rawInput != null) delta.rawInputJson = rawJson(u.rawInput);
  if (u.rawOutput != null) delta.rawOutputJson = rawJson(u.rawOutput);
  return delta;
}

/** Flatten ACP select options (which may be flat or grouped) into {id,name}. */
function flattenSelect(opts: unknown): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const o of (Array.isArray(opts) ? opts : []) as Array<Record<string, unknown>>) {
    if (o && typeof o.value === "string") out.push({ id: o.value, name: typeof o.name === "string" ? o.name : o.value });
    else if (o && Array.isArray(o.options)) out.push(...flattenSelect(o.options));
  }
  return out;
}

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

/** A clean, actionable error when an agent process dies before the ACP handshake.
 *  The per-agent hint lives in the shared registry (`startHint`). */
function startError(id: AgentId, code: number | null, stderr: string): string {
  const tail = stderr.trim().split("\n").filter(Boolean).slice(-2).join(" ").slice(-240);
  return `${labelFor(id)} exited before connecting${code != null ? ` (code ${code})` : ""}. ${AGENT_REGISTRY[id].startHint}${tail ? ` — ${tail}` : ""}`;
}
