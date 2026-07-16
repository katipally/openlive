import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { SseEvent, MessageBlock, LiveServerMsg } from "@openlive/shared";
import { LIVE_TAG, liveClientMsgSchema } from "@openlive/shared";
import { createChat, addMessage, listMessages, renameChat, getSetting, setSetting, setChatContext } from "@openlive/db";
import type { Message } from "@openlive/harness";
import type { Emit, OpenLiveTool } from "../tools.js";
import { foldBlock } from "../block-emit.js";
import { LiveTurnRunner } from "./turn-runner.js";
import { buildFileTools } from "./file-tools.js";
import { createBoundAgent, setBoundAgent, boundAgent, agentCwd, PERMISSION_CANCELLED, type Agent, type AgentId, type ReplayMessage } from "../agents/index.js";

type Frame = { data: string; mime: string };
type TurnFrame = Frame & { source: "camera" | "screen" };
const HISTORY_TURNS = 20; // recent messages to rehydrate on reconnect

// Some providers (e.g. MiniMax) leak control-token fragments like "[e[" into the
// text stream. Spoken replies never contain square brackets, so scrub them from
// saved text blocks — the live client strips the same noise for display/TTS.
function scrubControlTokens(blocks: MessageBlock[]): void {
  for (const b of blocks) {
    if (b.type === "text") b.text = b.text.replace(/[[\]][a-z0-9~!]{0,3}[[\]]/gi, " ").replace(/[[\]]/g, "").replace(/[ \t]{2,}/g, " ");
  }
}

// Strip OpenLive's OWN injected context out of a replayed user message so a resumed
// transcript reads as what the user actually said — not the voice/vision preamble,
// the "[Context — earlier…]" recap, or the "[The user is sharing…]" frame note. Each
// is a single `[…]` block with no internal `]`, so we match its opening marker and
// cut to the block's close — wherever it sits, and robust even if an agent's replay
// collapses the blank lines between blocks (a paragraph split would then over-strip).
const OPENLIVE_INJECTED = /\[(You're being used through OpenLive|Context — earlier in this voice conversation|The user is sharing their)[^\]]*\]/g;
export function stripInjectedContext(blocks: MessageBlock[]): MessageBlock[] {
  return blocks
    .map((b) => (b.type === "text"
      ? { ...b, text: b.text.replace(OPENLIVE_INJECTED, "").replace(/\n{3,}/g, "\n\n").trim() }
      : b))
    .filter((b) => b.type !== "text" || b.text.length > 0);
}

// Replace the assistant's spoken text in `blocks` with exactly what the client
// says was voiced on a barge-in (live replies are plain text — a clean swap).
function truncateSpokenText(blocks: MessageBlock[], spoken: string): void {
  const s = spoken.trim();
  let placed = false;
  for (const b of blocks) {
    if (b.type !== "text") continue;
    if (!placed) { b.text = s; placed = true; } else b.text = "";
  }
  if (!placed && s) blocks.unshift({ type: "text", text: s });
}

// One live call — THIN. The browser runs the whole voice stack (VAD, STT, turn
// detection, TTS) on-device; this server only receives the final user text + the
// freshest camera frame, runs the LLM turn, streams reply text back, and PERSISTS
// the conversation.
export class LiveSession {
  private runner: LiveTurnRunner;
  // When bound, a coding agent (Claude Code / Codex / Cursor) is the brain instead
  // of the provider loop. `agentReady` resolves once the ACP handshake completes.
  private agent: Agent | null = null;
  private boundId: AgentId | null = null;
  private boundCwd = ""; // the agent's project folder for this conversation (rebuild on change)
  private agentReady: Promise<void> | null = null;
  private agentAc: AbortController | null = null;
  private permPending = new Map<string, (optionId: string) => void>(); // agent permission asks awaiting the user
  private warmAc: AbortController | null = null; // aborts the cache-warm request on teardown
  private ac: AbortController | null = null;
  private turnActive = false;
  private queuedText: string | null = null; // an utterance that arrived mid-turn (barge-in)
  private bargeSpoken: string | null = null; // on barge-in, the text the client actually SPOKE
  private cameraOn = false;
  private screenOn = false;
  private titled = false;                  // rename the chat from the first user turn
  private lastFrame: Frame | null = null;  // freshest frame, for the `look` handshake
  private closed = false;

  // `look` tool ↔ client hi-res frame handshake.
  private lookPending: { reqId: string; resolve: (f: Frame | null) => void } | null = null;
  private awaitingLookFrame = false;
  // OS bridge (clipboard / open_url) ↔ client handshake. The client runs the
  // action via Electron and replies; on the web it replies "not available".
  private bridgePending = new Map<string, (out: string) => void>();

  constructor(private ws: WebSocket, private chatId: string) {
    const lookTool: OpenLiveTool = {
      name: "look",
      description: "Capture a fresh, higher-resolution frame from the user's camera and see it right now. Use when you need a closer or more current look at what the user is showing you. If the camera is off this returns nothing — then ask the user to turn it on.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        if (!this.cameraOn && !this.screenOn) return { output: "Nothing is being shared right now. Ask the user to turn on their camera or share their screen." };
        const frame = await this.requestFrame();
        if (!frame) return { output: "Couldn't grab a fresh frame (it timed out). Ask the user to check their camera / screen share." };
        const what = this.screenOn ? "the user's screen" : "the user's camera";
        return { output: `This is what ${what} is showing right now — talk about it naturally, as what you're both looking at.`, images: [frame] };
      },
    };
    const clipboardRead: OpenLiveTool = {
      name: "clipboard_read",
      description: "Read the text currently on the user's clipboard (what they just copied). Use when they say things like 'what did I just copy' or 'read my clipboard'. Desktop app only.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => ({ output: await this.bridge("clipboard_read") }),
    };
    const clipboardWrite: OpenLiveTool = {
      name: "clipboard_write",
      description: "Copy text to the user's clipboard so they can paste it somewhere. Use when they ask you to 'copy that' or 'put it on my clipboard'. Desktop app only.",
      parameters: { type: "object", properties: { text: { type: "string", description: "The text to place on the clipboard" } }, required: ["text"], additionalProperties: false },
      execute: async (args) => ({ output: await this.bridge("clipboard_write", String(args?.text ?? "")) }),
    };
    const openUrl: OpenLiveTool = {
      name: "open_url",
      description: "Open a web page in the user's default browser. Use when they ask you to open, pull up, or go to a site. Desktop app only.",
      parameters: { type: "object", properties: { url: { type: "string", description: "The http(s) URL to open" } }, required: ["url"], additionalProperties: false },
      execute: async (args) => ({ output: await this.bridge("open_url", String(args?.url ?? "")) }),
    };
    // File tools for the built-in assistant, scoped to this conversation's workspace
    // folder (`boundCwd`, read live so it tracks folder changes). Writes/edits go
    // through the same permission ask the coding agents use; reads are free.
    const fileTools = buildFileTools({ cwd: () => this.boundCwd, ask: (q, o) => this.askPermission(q, o) });
    this.runner = new LiveTurnRunner([lookTool, clipboardRead, clipboardWrite, openUrl, ...fileTools]);

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) this.onBinary(data);
      else this.onText(data.toString()).catch((e) => console.error("[live] text:", e));
    });
    ws.on("close", () => this.dispose());
    ws.on("error", () => this.dispose());
  }

  async start() {
    // Persist the chat row + rehydrate recent history (so a reconnect mid-call
    // doesn't make the agent forget what was already said).
    if (this.chatId) {
      createChat(this.chatId);
      const prior = this.rehydrate();
      if (prior.length) this.runner.seed(prior);
    }
    // Resume a persisted bind (the client also re-sends its remembered choice on
    // connect). A bound agent warms itself; the provider path warms the cache.
    this.applyBind(this.chatId ? boundAgent(this.chatId) : null);
    if (this.agent) return;
    // Warm the prompt cache + connection in the background so the first spoken turn
    // answers fast. Tell the client when it's done (drives the "Warming up…" spinner);
    // always signal ready, even on failure, so the indicator never sticks.
    this.warmAc = new AbortController();
    void this.runner.warm(this.warmAc.signal)
      .catch(() => {})
      .finally(() => { if (!this.closed) this.send({ t: "sse", event: { type: "status", text: "ready" } }); });
  }

  /** Stored messages → harness messages (text only — enough for continuity). */
  private rehydrate(): Message[] {
    let rows;
    try { rows = listMessages(this.chatId); } catch { return []; }
    const recent = rows.slice(-HISTORY_TURNS);
    const out: Message[] = [];
    for (const m of recent) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      const text = m.content.filter((b) => b.type === "text").map((b) => (b as any).text).join("").trim();
      if (text) out.push({ role: m.role, text });
    }
    return out;
  }

  // ── inbound ───────────────────────────────────────────────────────────────
  private onBinary(buf: Buffer) {
    if (buf[0] !== LIVE_TAG.FRAME_IN) return;
    const jpeg = Buffer.from(buf.subarray(1));
    const frame: Frame = { data: jpeg.toString("base64"), mime: "image/jpeg" };
    if (this.awaitingLookFrame && this.lookPending) {
      const p = this.lookPending;
      this.lookPending = null; this.awaitingLookFrame = false;
      p.resolve(frame);
      return;
    }
    this.lastFrame = frame; // freshest-per-turn camera frame
  }

  private async onText(str: string) {
    let msg;
    try { msg = liveClientMsgSchema.parse(JSON.parse(str)); } catch { return; }
    switch (msg.t) {
      case "user_text": return void this.runTurn(msg.text, msg.frames ?? []);
      case "cancel": if (this.turnActive) this.bargeSpoken = msg.spoken ?? null; return this.interrupt();
      case "control":
        if (msg.action === "camera_on") this.cameraOn = true;
        else if (msg.action === "camera_off") this.cameraOn = false;
        else if (msg.action === "screen_on") this.screenOn = true;
        else if (msg.action === "screen_off") this.screenOn = false;
        else if (msg.action === "end") this.dispose();
        if (!this.cameraOn && !this.screenOn) this.lastFrame = null;
        return;
      case "frame_response":
        if (this.lookPending?.reqId === msg.reqId) this.awaitingLookFrame = true;
        return;
      case "tool_bridge_result": {
        const r = this.bridgePending.get(msg.reqId);
        if (r) { this.bridgePending.delete(msg.reqId); r(msg.output); }
        return;
      }
      case "bind": return this.applyBind(msg.agentId, msg.cwd, msg.resumeSessionId);
      case "permission_response": {
        const r = this.permPending.get(msg.reqId);
        if (r) { this.permPending.delete(msg.reqId); r(msg.optionId); }
        return;
      }
      case "set_model": { this.agent?.setModel?.(msg.modelId)?.catch((e) => console.error("[live] set_model:", e)); return; }
      case "set_mode": { this.agent?.setMode?.(msg.modeId)?.catch((e) => console.error("[live] set_mode:", e)); return; }
      case "set_option": { this.agent?.setOption?.(msg.optionId, msg.valueId)?.catch((e) => console.error("[live] set_option:", e)); return; }
    }
  }

  /** Ask the client to run an OS action (clipboard / open_url) and await its
   *  result. On non-desktop clients the reply is instant ("not available"). */
  private bridge(op: "clipboard_read" | "clipboard_write" | "open_url", arg?: string): Promise<string> {
    return new Promise((resolve) => {
      const reqId = randomUUID();
      const timer = setTimeout(() => {
        if (this.bridgePending.delete(reqId)) resolve("That action timed out.");
      }, 5000);
      this.bridgePending.set(reqId, (out) => { clearTimeout(timer); resolve(out); });
      this.send({ t: "tool_bridge", reqId, op, arg });
    });
  }

  // ── turn ────────────────────────────────────────────────────────────────
  private async runTurn(text: string, frames: TurnFrame[] = []) {
    if (!text.trim() || this.closed) return;
    // A new utterance during an in-flight turn (barge-in) must NOT be dropped:
    // queue it (append) and the finally below drains it as one turn.
    if (this.turnActive) { this.queuedText = this.queuedText ? `${this.queuedText} ${text}` : text; return; }
    this.turnActive = true;
    const ac = new AbortController();
    this.ac = ac;

    const blocks: MessageBlock[] = [];
    const emit = this.blockEmit(blocks, ac.signal);

    if (this.chatId) {
      addMessage(this.chatId, "user", [{ type: "text", text }], true /* live */);
      // Auto-title the conversation from the first thing the user says.
      if (!this.titled) { this.titled = true; try { renameChat(this.chatId, text.replace(/\s+/g, " ").trim().slice(0, 48) || "Live conversation"); } catch { /* */ } }
    }
    try {
      if (this.agent) {
        await this.agentReady?.catch(() => {}); // wait out the ACP handshake on the first turn
        await this.agent.runTurn({ text, frames }, emit, ac.signal);
      } else {
        await this.runner.runTurn(text, frames, emit, ac.signal);
      }
    } catch (e) {
      if (!ac.signal.aborted) console.error("[live] turn:", e);
    } finally {
      // Turn is over (normally, barge-in, watchdog cut, or error) — never leave an
      // agent permission ask dangling; answer it cancelled (ACP MUST). No-op unless
      // one was actually pending.
      this.cancelPendingPermissions();
      // On barge-in, persist only what was actually SPOKEN.
      if (ac.signal.aborted && this.bargeSpoken != null) truncateSpokenText(blocks, this.bargeSpoken);
      this.bargeSpoken = null;
      scrubControlTokens(blocks);
      if (this.chatId && blocks.length) { try { addMessage(this.chatId, "assistant", blocks, true /* live */); } catch { /* */ } }
      this.send({ t: "sse", event: { type: "done" } });
      if (this.ac === ac) { this.ac = null; this.turnActive = false; }
      const q = this.queuedText; this.queuedText = null;
      if (q && !this.closed) void this.runTurn(q); // drain a barge-in utterance
    }
  }

  /** An Emit that both forwards SSE to the client and records ordered blocks.
   *  The signal gate drops late events after a barge-in aborts the spoken turn. */
  private blockEmit(blocks: MessageBlock[], signal: AbortSignal): Emit {
    return async (e: SseEvent) => {
      if (signal.aborted || this.closed) return; // barge-in → drop late events
      foldBlock(blocks, e);
      this.send({ t: "sse", event: e });
    };
  }

  private interrupt() {
    this.ac?.abort();
    this.cancelPendingPermissions();
  }

  /** Answer any in-flight agent permission ask as cancelled (ACP MUST when a turn is
   *  cancelled — barge-in OR a watchdog cut). Idempotent: resolving a settled promise
   *  and clearing an empty map both no-op. */
  private cancelPendingPermissions() {
    for (const r of this.permPending.values()) r(PERMISSION_CANCELLED);
    this.permPending.clear();
  }

  /** Persist + surface prior turns recovered from an agent's session/load. Only
   *  when the chat is empty (external-origin resume) — an OpenLive-origin chat
   *  already renders its own transcript, so the replayed copy is dropped (the load
   *  just re-primes the agent's context). */
  private ingestReplay(messages: ReplayMessage[]): void {
    if (!this.chatId || this.closed || !messages.length) return;
    try {
      if (listMessages(this.chatId).length > 0) return; // OpenLive-origin: keep our copy
      for (const m of messages) {
        const content = m.role === "user" ? stripInjectedContext(m.content) : m.content;
        if (content.length) addMessage(this.chatId, m.role, content);
      }
      this.send({ t: "reload_history" });
    } catch (e) { console.error("[live] replay ingest:", e); }
  }

  // ── agent binding ─────────────────────────────────────────────────────────
  /** Bind (or unbind) this conversation to a coding agent, optionally with a project
   *  folder. Rebuilds + reconnects the ACP agent when the agent OR folder changes;
   *  a no-op when neither did (an agent's cwd is fixed at spawn, so a folder switch
   *  means a restart). */
  private applyBind(id: AgentId | null, cwd?: string, resumeSessionId?: string) {
    if (cwd !== undefined && this.chatId) setSetting(`agentCwd:${this.chatId}`, cwd);
    // Resuming one of the agent's OWN prior sessions (from History): stamp its ACP
    // session id so createBoundAgent loadSession-s it instead of starting fresh.
    if (resumeSessionId && this.chatId) setSetting(`acpSession:${this.chatId}`, resumeSessionId);
    // Canonical, per-chat→global — the SAME resolution the agent spawns in, so the
    // rebuild guard below and History grouping stay consistent.
    const effectiveCwd = this.chatId ? agentCwd(this.chatId) : "";
    // Stamp the session's agent + workspace so the History sidebar can file it
    // under agent → workspace → session.
    if (this.chatId) setChatContext(this.chatId, id, effectiveCwd);
    if (id === this.boundId && effectiveCwd === this.boundCwd && this.agent) return;
    this.agentAc?.abort();
    void this.agent?.dispose();
    this.agent = null; this.agentReady = null; this.boundId = id; this.boundCwd = effectiveCwd;
    if (this.chatId) setBoundAgent(this.chatId, id);
    if (!id || this.closed || !this.chatId) return;
    // A coding agent needs a real folder. Don't spawn (then instantly kill) one with
    // no cwd — that surfaced a spurious "pick a folder" error and churned processes on
    // the first bind. Wait for a bind that supplies a folder (the lobby gates Start on it).
    if (!effectiveCwd) return;
    const agent = createBoundAgent(this.chatId, (q, o) => this.askPermission(q, o), {
      onMeta: (meta) => { if (!this.closed) this.send({ t: "agent_meta", ...meta }); },
      // Recovered transcript from a session/load — persist + tell the client to reload.
      onReplay: (msgs) => this.ingestReplay(msgs),
    });
    if (!agent) return;
    this.agent = agent;
    const prior = this.rehydrate();
    if (prior.length) agent.seed(prior);
    const ac = new AbortController(); this.agentAc = ac;
    this.agentReady = agent.start(ac.signal)
      .then(() => { if (!this.closed) this.send({ t: "sse", event: { type: "status", text: "ready" } }); })
      .catch((e) => { if (!this.closed) this.send({ t: "sse", event: { type: "error", message: `Couldn't start ${id}: ${String((e as Error)?.message ?? e)}` } }); });
  }

  /** Relay an agent permission ask to the client (spoken + chips) and await the
   *  chosen option id; times out to "deny" so a hung decision never wedges a turn. */
  private askPermission(question: string, options: { id: string; label: string }[]): Promise<string> {
    return new Promise((resolve) => {
      if (this.closed) return resolve("deny");
      const reqId = randomUUID();
      const timer = setTimeout(() => { if (this.permPending.delete(reqId)) resolve("deny"); }, 120_000);
      this.permPending.set(reqId, (optionId) => { clearTimeout(timer); resolve(optionId); });
      this.send({ t: "permission", reqId, question, options });
    });
  }

  // ── `look` handshake ────────────────────────────────────────────────────
  private requestFrame(): Promise<Frame | null> {
    return new Promise((resolve) => {
      const reqId = randomUUID();
      const timer = setTimeout(() => {
        if (this.lookPending?.reqId === reqId) { this.lookPending = null; this.awaitingLookFrame = false; resolve(null); }
      }, 4000);
      this.lookPending = { reqId, resolve: (f) => { clearTimeout(timer); resolve(f); } };
      this.awaitingLookFrame = false;
      this.send({ t: "need_frame", reqId });
    });
  }

  // ── send / teardown ───────────────────────────────────────────────────────
  private send(m: LiveServerMsg) {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(m));
  }

  private dispose() {
    if (this.closed) return;
    this.closed = true;
    this.warmAc?.abort();
    this.ac?.abort();
    this.agentAc?.abort();
    void this.agent?.dispose();
    for (const r of this.permPending.values()) r("deny");
    this.permPending.clear();
    this.lookPending?.resolve(null);
    for (const r of this.bridgePending.values()) r("The session ended.");
    this.bridgePending.clear();
    try { this.ws.close(); } catch { /* already closing */ }
  }
}
