import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { SseEvent, MessageBlock, LiveServerMsg } from "@openlive/shared";
import { LIVE_TAG, liveClientMsgSchema, agentLabel, classifyError, withReplyLanguage, type AgentMetaWire, type LanguageCode } from "@openlive/shared";
import { createChat, addMessage, updateMessageContent, listMessages, renameChat, getSetting, setSetting, setChatContext } from "@openlive/db";
import type { Message } from "@openlive/harness";
import type { Approve, Emit, Session, Tool } from "../capabilities/types.js";
import { registry } from "../capabilities/registry.js";
import { CHAT } from "../capabilities/profiles.js";
import { ToolSet } from "../capabilities/dispatch.js";
import { bridgedDevice, DEVICE_TIMEOUT_MS } from "../capabilities/device.js";
import { computer } from "../computer/helper.js";
import { MCP_SERVER_NAME, serveMcp } from "../capabilities/mcp.js";
import { slashSkill } from "../skills/tools.js";
import { finalizeToolBlocks, foldBlock, newFoldCtx, type FoldCtx } from "../block-emit.js";
import { LiveTurnRunner } from "./turn-runner.js";
import { narrationEnabled, wrapEmitWithNarration, createCommentaryGate } from "./narrator.js";
import { hostedBy } from "../agents/mcp-config.js";
import { createBoundAgent, setBoundAgent, boundAgent, agentCwd, PERMISSION_CANCELLED, type Agent, type AgentId, type ElicitationAnswer, type ElicitationAsk, type PermissionAskOption, type ReplayMessage } from "../agents/index.js";
import { emitFact, type AgentFactProps } from "../telemetry/emit.js";
import { askOutcome, brainOf, permissionFact, toolTally, reportReply, reportTurnError, TurnTimer, type Brain as BrainIdent, type PermissionOutcome } from "../telemetry/facts.js";
import { resolveLive } from "../providers.js";
import { log } from "../log.js";
import { cancelledText, sentAside } from "../turn.js";
import { liveSockets, type ReminderMsg } from "../reminders/fire.js";

type Frame = { data: string; mime: string };
type TurnFrame = Frame & { source: "camera" | "screen" | "attachment" };
const HISTORY_TURNS = 20; // recent messages to rehydrate on reconnect
const BRIDGE_TIMEOUT_MS = 5_000;
/** Tools whose work shows on its own: the worker's searches, and the checklist. */
const OWN_UI = new Set(["delegate", "update_todos"]);
/** Kinds given, so a no is counted as one and the client maps a spoken answer. */
const ALLOW_OR_DENY: PermissionAskOption[] = [{ id: "allow", label: "Allow", kind: "allow_once" }, { id: "deny", label: "Deny", kind: "reject_once" }];
/** The argument a chip names, the first one a tool has. */
const CHIP_ARGS = ["url", "note", "path", "command", "name"];

// Some providers (e.g. MiniMax) leak control-token fragments like "[e[" into the
// text stream. Scrub ONLY those bracket-pair fragments — NOT every bracket: coding
// agents legitimately say things like `arr[0]`, and blanket-stripping brackets
// corrupted saved transcripts (`arr 0`). The live client strips the same noise for
// display/TTS.
function scrubControlTokens(blocks: MessageBlock[]): void {
  for (const b of blocks) {
    if (b.type === "text") b.text = b.text.replace(/[[\]][a-z0-9~!]{0,3}[[\]]/gi, " ").replace(/[ \t]{2,}/g, " ");
  }
}

// Strip OpenLive's OWN injected context out of a replayed user message so a resumed
// transcript reads as what the user actually said — not the voice/vision preamble,
// the "[Context — earlier…]" recap, or the "[The user is sharing…]" frame note. Each
// is a single `[…]` block with no internal `]`, so we match its opening marker and
// cut to the block's close — wherever it sits, and robust even if an agent's replay
// collapses the blank lines between blocks (a paragraph split would then over-strip).
const OPENLIVE_INJECTED = /\[(You're being used through OpenLive|How the user wants you to behave|Context \u2014 earlier in this voice conversation|The user is sharing their|A vision model is looking at the user's|Always reply in|The user cut you off|The user cancelled|This was first taken for the user talking)[^\]]*\]/g;
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

/** The agent reports its use of the call's own tools as tool calls of its own.
 *  Dropped, so they show as the built-in brain's do and not twice; their ids
 *  are kept in `hidden`. */
function hideHosted(emit: Emit, hidden: Set<string>): Emit {
  return (e) => {
    if (e.type === "acp_tool_call" && hostedBy(e.call.title, MCP_SERVER_NAME)) hidden.add(e.call.id);
    const id = e.type === "acp_tool_call" ? e.call.id : e.type === "acp_tool_update" ? e.delta.id : "";
    return id && hidden.has(id) ? undefined : emit(e);
  };
}

// One live call — THIN. The browser runs the whole voice stack (VAD, STT, turn
// detection, TTS) on-device; this server only receives the final user text + the
// freshest camera frame, runs the LLM turn, streams reply text back, and PERSISTS
// the conversation.
export class LiveSession {
  private runner: LiveTurnRunner;
  private toolSession: Session;
  // When bound, a coding agent (Claude Code / Codex / Cursor) is the brain instead
  // of the provider loop. `agentReady` resolves once the ACP handshake completes.
  private agent: Agent | null = null;
  private boundId: AgentId | null = null;
  private boundCwd = ""; // the agent's project folder for this conversation (rebuild on change)
  private lastMeta: AgentMetaWire | null = null; // last agent_meta sent — re-sent on a same-bind rebind
  private elicitPending = new Map<string, (a: ElicitationAnswer) => void>(); // by reqId
  private elicitById = new Map<string, (a: ElicitationAnswer) => void>();    // by agent elicitationId (URL completion)
  private lastBind: Promise<void> = Promise.resolve(); // most recent applyBind, awaited by start()
  private agentReady: Promise<void> | null = null;
  private agentAc: AbortController | null = null;
  private permPending = new Map<string, (optionId: string, outcome?: PermissionOutcome) => void>(); // agent permission asks awaiting the user
  private agentStartMs = 0; // what the bound agent took to start; 0 without one
  // How the agent's session came up. It is known in the lobby, before the call's
  // record opens, so each turn's fact carries it in.
  private resumed: AgentFactProps<"call">["resumed"];
  private warmAc: AbortController | null = null; // aborts the cache-warm request on teardown
  private ac: AbortController | null = null;
  private turnActive = false;
  // The agent's ids for its calls to the call's own tools in a stopped turn:
  // refused should one land late, in the next turn.
  private deadHosted = new Set<string>();
  // An utterance (with its frames) that arrived mid-turn (barge-in), drained when the
  // current turn settles. Frames are queued too so a barge-in with the camera on
  // doesn't lose what the user was showing.
  private queued: { text: string; frames: TurnFrame[]; lang?: LanguageCode; turn?: number; wordsAt?: number[]; speaker?: string; aside?: boolean; typed?: boolean } | null = null;
  private bargeSpoken: string | null = null; // on barge-in, the text the client actually SPOKE
  private cutSaved: Promise<unknown> = Promise.resolve(); // the last cut written for a coding agent
  // The client's number for the utterance the running turn answers, echoed on its
  // events.
  private replyTurn: number | undefined;
  // The last saved reply, while the client may still be voicing it: a model streams
  // its text far faster than speech, so most barge-ins land after the turn is over.
  private lastReply: { id: string; blocks: MessageBlock[]; byRunner: boolean } | null = null;
  private startup: Promise<void> = Promise.resolve();
  private bindEpoch = 0;                      // guards applyBind against re-entrant/overlapping binds
  private expectReplay = false;               // this chat was empty when a resume began → persist recovered turns
  private frameChain: Promise<unknown> = Promise.resolve(); // serialize concurrent `look` frame grabs
  private cameraOn = false;
  private screenOn = false;
  private titled = false;                  // rename the chat from the first user turn
  private closed = false;

  // `look` tool ↔ client hi-res frame handshake.
  private lookPending: { reqId: string; resolve: (f: Frame | null) => void } | null = null;
  private awaitingLookFrame = false;
  // OS bridge (clipboard / open_url / the device) ↔ client handshake. The client
  // runs the action via Electron and replies; on the web it replies "not available".
  private bridgePending = new Map<string, (out: string) => void>();
  // The call's tools, served to a coding agent over MCP: the same set the
  // built-in brain runs, so one implementation answers both.
  private tools: ToolSet;
  private approve: Approve;
  private mcp: ReturnType<typeof serveMcp> | null = null;
  /** The running turn's emit, so a tool shows its chip in that turn. */
  private toolEmit: Emit = () => {};
  /** A timer or reminder that went off, for the client to show and say. */
  private readonly hear = (m: ReminderMsg) => this.send(m);

  /** `device`: the client is the desktop app, which can reach the ol-input addon. */
  constructor(private ws: WebSocket, private chatId: string, private lang?: LanguageCode, device = false) {
    // What the call can reach. The client answers every bridge op; the camera
    // frame for the device comes from the share the call already holds.
    this.toolSession = {
      clipboard: { read: () => this.bridge("clipboard_read"), write: (text) => this.bridge("clipboard_write", text) },
      openUrl: (url) => this.bridge("open_url", url),
      share: { showing: () => (this.screenOn ? "screen" : this.cameraOn ? "camera" : null), frame: () => this.requestFrame() },
      // Read live, so the file tools track a folder change mid-call.
      workspace: () => this.boundCwd,
      emit: (e) => this.toolEmit(e),
      elicit: (req) => this.askElicitation(req),
      ...(device && { device: bridgedDevice((arg) => this.bridge("flow_device", arg, DEVICE_TIMEOUT_MS), async () => (this.cameraOn ? this.requestFrame() : null)) }),
      ...(device && computer.available() && { computer }),
    };
    this.tools = this.callTools();
    this.approve = CHAT.approval((question) => this.askPermission(question, ALLOW_OR_DENY).then((id) => id === "allow"));
    this.runner = new LiveTurnRunner(this.tools, this.toolSession, { approve: this.approve, tally: toolTally("call") });

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) this.onBinary(data);
      else this.onText(data.toString()).catch((e) => log.error("live", "text:", e));
    });
    ws.on("close", () => this.dispose());
    ws.on("error", () => this.dispose());
    liveSockets.add(this.hear);
  }

  start(): Promise<void> { return (this.startup = this.boot()); }

  private async boot() {
    // Persist the chat row + rehydrate recent history (so a reconnect mid-call
    // doesn't make the agent forget what was already said).
    if (this.chatId) {
      await createChat(this.chatId);
      const prior = this.rehydrate();
      if (prior.length) this.runner.seed(prior);
    }
    // Resume a persisted bind — but ONLY if the client's own bind hasn't already
    // arrived. The client re-sends its choice the moment the socket opens, and on a
    // NEW chat that message can beat this restore: the restore then read stale/empty
    // DB state, superseded the client's bind via the epoch guard, and quietly
    // reversed it — agent + folder shown in the UI, nothing bound on the server.
    if (this.bindEpoch === 0) await this.applyBind(this.chatId ? boundAgent(this.chatId) : null);
    else await this.lastBind; // let the in-flight client bind finish deciding
    if (this.agent) return;
    // Warm the prompt cache + connection in the background so the first spoken turn
    // answers fast. Tell the client when it's done (drives the "Warming up…" spinner);
    // always signal ready, even on failure, so the indicator never sticks.
    this.warmAc = new AbortController();
    // A turn waiting on this start primes the cache itself; a warm-up would send it twice.
    void (this.turnActive ? Promise.resolve() : this.runner.warm(this.warmAc.signal, this.lang))
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
    const asked = out.findLast((m) => m.role === "user");
    if (asked && this.pendingCut()?.cancelled) asked.text = cancelledText(asked.text);
    return out;
  }

  // ── inbound ───────────────────────────────────────────────────────────────
  private onBinary(buf: Buffer) {
    if (buf[0] !== LIVE_TAG.FRAME_IN) return;
    if (!this.awaitingLookFrame || !this.lookPending) return;
    const p = this.lookPending;
    this.lookPending = null; this.awaitingLookFrame = false;
    p.resolve({ data: Buffer.from(buf.subarray(1)).toString("base64"), mime: "image/jpeg" });
  }

  private async onText(str: string) {
    let msg;
    try { msg = liveClientMsgSchema.parse(JSON.parse(str)); } catch { return; }
    switch (msg.t) {
      case "user_text":
        // A permission/elicitation may be awaiting the user. A client showing it answers
        // it there, so a sentence landing here was said before the ask reached the
        // client, which then drops the ask as an older turn's: nobody can answer it. It
        // is refused, and the sentence is a turn like any other.
        this.cancelPendingPermissions();
        this.cancelPendingElicitations();
        return void this.runTurn(msg.text, msg.frames ?? [], msg.lang, msg.turn, msg.wordsAt, msg.speaker, msg.aside, msg.typed);
      case "cancel":
        emitFact("call", { interrupted: 1 });
        // A client showing an ask holds its barge-in, so a cancel means the ask never
        // reached it: the ask is refused along with the turn.
        if (this.turnActive) this.bargeSpoken = msg.spoken ?? "";
        else if (msg.spoken != null) this.cutSavedReply(msg.spoken);
        return this.interrupt();
      case "control":
        if (msg.action === "camera_on") { this.cameraOn = true; emitFact("call", { camera_used: true }); }
        else if (msg.action === "camera_off") this.cameraOn = false;
        else if (msg.action === "screen_on") { this.screenOn = true; emitFact("call", { screen_used: true }); }
        else if (msg.action === "screen_off") this.screenOn = false;
        else if (msg.action === "end") this.dispose();
        return;
      case "frame_response":
        if (this.lookPending?.reqId !== msg.reqId) return;
        if (msg.failed) { const p = this.lookPending; this.lookPending = null; this.awaitingLookFrame = false; p.resolve(null); }
        else this.awaitingLookFrame = true;
        return;
      case "tool_bridge_result": {
        const r = this.bridgePending.get(msg.reqId);
        if (r) { this.bridgePending.delete(msg.reqId); r(msg.output); }
        return;
      }
      case "bind": return this.applyBind(msg.agentId, msg.cwd, msg.resumeSessionId);
      case "permission_response": {
        this.permPending.get(msg.reqId)?.(msg.optionId); // settle() clears the map + notifies the client
        return;
      }
      case "elicitation_response": {
        this.elicitPending.get(msg.reqId)?.({ action: msg.action, content: msg.content as Record<string, unknown> | undefined });
        return;
      }
      case "set_model": { this.agent?.setModel?.(msg.modelId)?.catch((e) => log.error("live", "set_model:", e)); return; }
      case "set_mode": { this.agent?.setMode?.(msg.modeId)?.catch((e) => log.error("live", "set_mode:", e)); return; }
      case "set_option": { this.agent?.setOption?.(msg.optionId, msg.valueId)?.catch((e) => log.error("live", "set_option:", e)); return; }
    }
  }

  /** Ask the client to run an OS action (clipboard / open_url / the device) and
   *  await its result. On non-desktop clients the reply is instant ("not available"). */
  private bridge(op: "clipboard_read" | "clipboard_write" | "open_url" | "flow_device", arg?: string, timeoutMs = BRIDGE_TIMEOUT_MS): Promise<string> {
    return new Promise((resolve) => {
      const reqId = randomUUID();
      const timer = setTimeout(() => {
        if (this.bridgePending.delete(reqId)) resolve("That action timed out.");
      }, timeoutMs);
      this.bridgePending.set(reqId, (out) => { clearTimeout(timer); resolve(out); });
      this.send({ t: "tool_bridge", reqId, op, arg, turn: this.replyTurn });
    });
  }

  // ── turn ────────────────────────────────────────────────────────────────
  private async runTurn(text: string, frames: TurnFrame[] = [], lang?: LanguageCode, turn?: number, wordsAt?: number[], speaker?: string, aside?: boolean, typed?: boolean) {
    if (!text.trim() || this.closed) return;
    // A new utterance during an in-flight turn (barge-in) must NOT be dropped:
    // queue it (append text, keep the freshest frames) and the finally below drains
    // it as one turn.
    if (this.turnActive) {
      const had = this.queued?.frames ?? [];
      const live = (fs: TurnFrame[]) => fs.filter((f) => f.source !== "attachment");
      const attached = (fs: TurnFrame[]) => fs.filter((f) => f.source === "attachment");
      this.queued = {
        text: this.queued ? `${this.queued.text} ${text}` : text,
        // The freshest live view, and every image the user attached along the way.
        frames: [...attached(had), ...attached(frames), ...(live(frames).length ? live(frames) : live(had))],
        lang,
        turn,
        // Two utterances' onsets count from two different starts: a joined turn keeps none.
        wordsAt: this.queued ? undefined : wordsAt,
        speaker: !this.queued || this.queued.speaker === speaker ? speaker : undefined,
        // A joined turn is mostly not what was sent on, so it is not flagged.
        aside: !this.queued && aside,
        typed: !this.queued && typed,
      };
      return;
    }
    this.turnActive = true;
    this.replyTurn = turn;
    this.lastReply = null;
    const ac = new AbortController();
    this.ac = ac;
    // A reconnect flushes a queued utterance right behind the bind: wait for the
    // history and the bound agent, or the turn is saved into the history it then
    // loads twice, and goes to the built-in brain instead of the agent.
    await this.startup.catch(() => {});

    let said = aside ? sentAside(text) : text;
    const blocks: MessageBlock[] = [];
    const hosted = new Set<string>();
    const foldCtx = newFoldCtx();
    const turnStats = { timer: new TurnTimer(), failed: false };
    const emit = this.blockEmit(blocks, ac.signal, foldCtx, turnStats);

    if (this.chatId) {
      await addMessage(this.chatId, "user", [{ type: "text", text, ...(wordsAt && { wordsAt }), ...(speaker && { speaker }), ...(typed && { typed }) }], true /* live */).catch((e) => log.error("live", "persist user turn:", e));
      // Auto-title the conversation from the first thing the user says.
      if (!this.titled) { this.titled = true; await renameChat(this.chatId, text.replace(/\s+/g, " ").trim().slice(0, 48) || "Live conversation").catch(() => {}); }
    }
    // Clean, agent-agnostic speech for the whole turn:
    //  • wrapEmitWithNarration — a short voiced status line for long tool runs (opt-out).
    //  • createCommentaryGate — speak the opening line + final answer only; mid-work
    //    commentary between tools goes to the (unspoken) reasoning channel. `flush()`
    //    after the turn resolves voices the buffered final answer.
    // Both wrap the SAME emit, so every agent (and the built-in brain) behaves alike.
    const narrated = narrationEnabled(getSetting("narrateProgress")) ? wrapEmitWithNarration(emit, ac.signal) : emit;
    const gate = createCommentaryGate(narrated, ac.signal);
    this.toolEmit = gate.emit;
    try {
      await this.agentReady?.catch(() => {}); // wait out the ACP handshake on the first turn
      await this.cutSaved;
      if (this.chatId && getSetting(`agentCut:${this.chatId}`)) await setSetting(`agentCut:${this.chatId}`, "");
      // A typed "/name" loads that OpenLive skill for the turn, unless the bound
      // agent has a command by that name: the agent's own commands come first.
      const word = typed && !aside ? /^\/(\S+)/.exec(text.trim())?.[1] : undefined;
      const skill = word && !this.lastMeta?.commands.some((c) => c.name === word)
        ? await slashSkill(text, this.tools, { ...this.toolSession, signal: ac.signal, context: null })
        : null;
      if (skill) said = `${skill.content}\n\n${skill.rest || `Use the ${skill.name} skill.`}`;
      if (this.agent) {
        await this.agent.runTurn({ text: withReplyLanguage(said, lang), frames, ...(!aside && !skill && text.trimStart().startsWith("/") && { command: text }) }, hideHosted(gate.emit, hosted), ac.signal);
        await gate.flush();
      } else if (this.boundId) {
        // A coding agent is bound but not running (no folder yet, or its start
        // failed). NEVER answer with the built-in brain as if it were the agent —
        // that silently swaps who the user is talking to. Say what's wrong instead.
        const label = agentLabel(this.boundId);
        await emit({
          type: "error",
          message: this.boundCwd
            ? `${label} isn't connected yet. Give it a moment, or switch agents and back to retry.`
            : `${label} needs a project folder before it can start. Pick one from the folder menu in the top bar, then ask again.`,
          code: this.boundCwd ? "agent_start_failed" : "agent_no_folder",
        });
      } else {
        await this.runner.runTurn(said, frames, gate.emit, ac.signal, lang);
        await gate.flush();
      }
    } catch (e) {
      if (!ac.signal.aborted) {
        log.error("live", "turn:", e);
        // A thrown turn was invisible before — the call went quiet with no clue.
        try { await emit({ type: "error", message: `That didn't go through: ${String((e as Error)?.message ?? e)}`, code: classifyError(e) }); } catch { /* emit is best-effort */ }
      }
    } finally {
      // Turn is over (normally, barge-in, watchdog cut, or error) — never leave an
      // agent permission ask dangling; answer it cancelled (ACP MUST). No-op unless
      // one was actually pending.
      this.cancelPendingPermissions();
      this.toolEmit = () => {};
      for (const id of ac.signal.aborted ? hosted : []) this.deadHosted.add(id);
      const byRunner = !this.agent && !this.boundId;
      // On barge-in, persist only what was actually SPOKEN.
      if (ac.signal.aborted && this.bargeSpoken != null) {
        truncateSpokenText(blocks, this.bargeSpoken);
        if (byRunner) this.runner.truncateReply(this.bargeSpoken);
        this.cutAgentReply(this.bargeSpoken, true);
      }
      this.bargeSpoken = null;
      scrubControlTokens(blocks);
      // Snapshot live terminal output into its tool calls + settle unfinished
      // statuses (pending/in_progress → canceled) before the turn is persisted.
      finalizeToolBlocks(blocks, foldCtx);
      const own = blocks.filter((b) => b.type === "acp_tool");
      const ownFailed = own.filter((b) => b.call.status === "failed").length;
      const answered = !ac.signal.aborted && !turnStats.failed;
      emitFact("call", {
        ...this.brain(), turns: 1, lang: lang ?? "en", agent_start_ms: this.agentStartMs, ...(this.resumed && { resumed: this.resumed }),
        ...(own.length && { agent_tools: own.length }), ...(ownFailed && { agent_tools_failed: ownFailed }),
        ...turnStats.timer.timings(answered),
      });
      if (answered) reportReply("call");
      if (this.chatId && blocks.length) {
        const saved = await addMessage(this.chatId, "assistant", blocks, true /* live */).catch((e) => { log.error("live", "persist assistant turn:", e); return null; });
        if (saved && !ac.signal.aborted) this.lastReply = { id: saved.id, blocks, byRunner };
      }
      this.send({ t: "sse", event: { type: "done" }, turn: this.replyTurn });
      if (this.ac === ac) { this.ac = null; this.turnActive = false; }
      const q = this.queued; this.queued = null;
      if (q && !this.closed) void this.runTurn(q.text, q.frames, q.lang, q.turn, q.wordsAt, q.speaker, q.aside, q.typed); // drain a barge-in utterance (with its frames)
    }
  }

  /** An Emit that both forwards SSE to the client and records ordered blocks.
   *  The signal gate drops late events after a barge-in aborts the spoken turn. */
  private blockEmit(blocks: MessageBlock[], signal: AbortSignal, ctx: FoldCtx, stats: { timer: TurnTimer; failed: boolean }): Emit {
    return async (e: SseEvent) => {
      if (signal.aborted || this.closed) return; // barge-in → drop late events
      if (e.type === "text_delta") stats.timer.firstText();
      else if (e.type === "error") { stats.failed = true; reportTurnError("call", this.brain(), e); }
      foldBlock(blocks, e, ctx);
      this.send({ t: "sse", event: e, turn: this.replyTurn });
    };
  }

  /** A barge-in after the reply was saved: cut it, and the model's memory of it,
   *  back to what the voice had said. */
  private cutSavedReply(spoken: string) {
    const r = this.lastReply;
    this.lastReply = null;
    if (!r) return;
    truncateSpokenText(r.blocks, spoken);
    if (r.byRunner) this.runner.truncateReply(spoken);
    else this.cutAgentReply(spoken);
    try { updateMessageContent(r.id, r.blocks); } catch (e) { log.error("live", "cut saved reply:", e); }
  }

  /** A coding agent keeps its own memory of the reply, and a resumed session
   *  brings it back: the cut waits in the settings until a turn has told it. A
   *  cancelled request waits there for the built-in brain's next call too. */
  private cutAgentReply(spoken: string, cancelled = false) {
    this.agent?.cut?.(spoken, cancelled);
    if (this.chatId) this.cutSaved = setSetting(`agentCut:${this.chatId}`, JSON.stringify({ spoken, cancelled })).catch(() => {});
  }

  /** The cut no turn has told the brain yet. A bare string is one saved before cancels were kept. */
  private pendingCut(): { spoken: string; cancelled?: boolean } | null {
    const raw = this.chatId ? getSetting(`agentCut:${this.chatId}`) : "";
    if (!raw) return null;
    const cut = JSON.parse(raw) as string | { spoken: string; cancelled?: boolean };
    return typeof cut === "string" ? { spoken: cut } : cut;
  }

  private interrupt() {
    this.ac?.abort();
    this.cancelPendingPermissions();
    this.cancelPendingElicitations();
  }

  /** Answer any in-flight agent permission ask as cancelled (ACP MUST when a turn is
   *  cancelled — barge-in OR a watchdog cut). Idempotent: settle() removes each from
   *  the map (so iterate a copy) and no-ops if already settled. */
  private cancelPendingPermissions() {
    for (const settle of [...this.permPending.values()]) settle(PERMISSION_CANCELLED);
  }

  /** Persist + surface prior turns recovered from an agent's session/load. Only
   *  when the chat is empty (external-origin resume) — an OpenLive-origin chat
   *  already renders its own transcript, so the replayed copy is dropped (the load
   *  just re-primes the agent's context). */
  private async ingestReplay(messages: ReplayMessage[]): Promise<void> {
    if (!this.chatId || this.closed || !messages.length) return;
    // `expectReplay` was decided at bind time, BEFORE any user turn could persist —
    // so a user who spoke before the load finished can't flip this to "OpenLive-origin"
    // and drop the recovered transcript (the old listMessages check raced that turn).
    if (!this.expectReplay) return;
    this.expectReplay = false; // ingest once
    try {
      for (const m of messages) {
        const content = m.role === "user" ? stripInjectedContext(m.content) : m.content;
        if (content.length) await addMessage(this.chatId, m.role, content); // sequential: keep order
      }
      this.send({ t: "reload_history" });
    } catch (e) { log.error("live", "replay ingest:", e); }
  }

  // ── agent binding ─────────────────────────────────────────────────────────
  /** Bind (or unbind) this conversation to a coding agent, optionally with a project
   *  folder. Rebuilds + reconnects the ACP agent when the agent OR folder changes;
   *  a no-op when neither did (an agent's cwd is fixed at spawn, so a folder switch
   *  means a restart). */
  private async applyBind(id: AgentId | null, cwd?: string, resumeSessionId?: string) {
    // Re-entrancy guard: applyBind awaits several writes, and binds can overlap (a
    // fast agent/folder switch, or a resume racing a reconnect). Stamp an epoch and
    // bail the moment a newer bind supersedes this one — otherwise two runs each spawn
    // an agent and the older one leaks an orphaned ACP child-process tree.
    const epoch = ++this.bindEpoch;
    const run = this.applyBindInner(id, cwd, resumeSessionId, epoch);
    this.lastBind = run.catch(() => {});
    await run;
    // Authoritative echo — whatever this bind attempt ended up with (including the
    // superseding-bind and no-folder paths that return early above), tell the client
    // what the session is ACTUALLY using so its chips can't drift from reality.
    if (epoch === this.bindEpoch && !this.closed) {
      this.send({ t: "bound_state", agentId: this.boundId, cwd: this.boundCwd, agentActive: !!this.agent });
    }
  }

  private async applyBindInner(id: AgentId | null, cwd: string | undefined, resumeSessionId: string | undefined, epoch: number) {
    // These two MUST land before agentCwd()/createBoundAgent read them back.
    if (cwd !== undefined && this.chatId) await setSetting(`agentCwd:${this.chatId}`, cwd);
    // Resuming one of the agent's OWN prior sessions (from History): stamp its ACP
    // session id so createBoundAgent loadSession-s it instead of starting fresh.
    if (resumeSessionId && this.chatId) await setSetting(`acpSession:${this.chatId}`, resumeSessionId);
    if (epoch !== this.bindEpoch) return; // superseded while awaiting
    // Canonical, per-chat→global — the SAME resolution the agent spawns in, so the
    // rebuild guard below and History grouping stay consistent.
    const effectiveCwd = this.chatId ? agentCwd(this.chatId) : "";
    // Stamp the session's agent + workspace so the History sidebar can file it
    // under agent → workspace → session.
    if (this.chatId) await setChatContext(this.chatId, id, effectiveCwd);
    if (epoch !== this.bindEpoch) return;
    if (id === this.boundId && effectiveCwd === this.boundCwd && this.agent) {
      // Same bind, agent already up. The client may have cleared its model/mode
      // chips (start() reuses the prewarmed socket and nulls them) — re-send the
      // last meta so they come back without a rebuild.
      if (this.lastMeta) this.send({ t: "agent_meta", ...this.lastMeta });
      return;
    }
    const moved = effectiveCwd !== this.boundCwd;
    this.agentAc?.abort();
    void this.agent?.dispose();
    this.agent = null; this.agentReady = null; this.lastMeta = null; this.boundId = id; this.boundCwd = effectiveCwd; this.agentStartMs = 0; this.resumed = undefined;
    if (moved) { this.tools = this.callTools(); this.runner.tools = this.tools; }
    if (this.chatId) await setBoundAgent(this.chatId, id);
    if (epoch !== this.bindEpoch) return;
    if (!id || this.closed || !this.chatId) return;
    // A coding agent needs a real folder. Don't spawn (then instantly kill) one with
    // no cwd — that surfaced a spurious "pick a folder" error and churned processes on
    // the first bind. Wait for a bind that supplies a folder (the lobby gates Start on it).
    if (!effectiveCwd) return;
    // Decide replay-persistence NOW, before any user turn can persist a message — so a
    // user who speaks before the session/load finishes doesn't make ingestReplay think
    // the chat is OpenLive-origin and drop the recovered transcript.
    this.expectReplay = !!resumeSessionId && listMessages(this.chatId).length === 0;
    const call = this;
    const mcp = await (this.mcp ??= serveMcp({
      // Read per request, so a new folder's skills are served once it is bound.
      get tools() { return call.tools; },
      // A call arriving outside a turn is refused, as the built-in brain never makes
      // one, and so is one a stopped turn made that lands in the next.
      ctx: (agentCallId) => ({ ...this.toolSession, context: null, signal: (agentCallId && this.deadHosted.has(agentCallId) ? null : this.ac?.signal) ?? AbortSignal.abort() }),
      approve: this.approve,
      tally: toolTally("call"),
    }));
    if (epoch !== this.bindEpoch || this.closed) return;
    const agent = createBoundAgent(this.chatId, (q, o, toolCallId) => this.askPermission(q, o, toolCallId), {
      onMeta: (meta) => { this.lastMeta = meta; if (!this.closed) this.send({ t: "agent_meta", ...meta }); },
      // Recovered transcript from a session/load — persist + tell the client to reload.
      onReplay: (msgs) => this.ingestReplay(msgs),
      askElicitation: (req) => this.askElicitation(req),
      completeElicitation: (elicitationId) => this.elicitById.get(elicitationId)?.({ action: "accept" }),
      mcp: { wire: mcp.wire, tools: this.tools.list.map((t) => t.name) },
      replay: this.expectReplay,
      onResumed: (how) => { this.resumed = how; },
    });
    if (!agent) return;
    this.agent = agent;
    const prior = this.rehydrate();
    if (prior.length) agent.seed(prior);
    const cut = this.pendingCut();
    if (cut) agent.cut?.(cut.spoken, cut.cancelled);
    const ac = new AbortController(); this.agentAc = ac;
    const startedAt = performance.now();
    this.agentReady = agent.start(ac.signal)
      .then(() => {
        this.agentStartMs = Math.round(performance.now() - startedAt);
        if (!this.closed) this.send({ t: "sse", event: { type: "status", text: "ready" } });
      })
      .catch((e) => {
        if (this.closed) return;
        const event = { type: "error" as const, message: `Couldn't start ${id}: ${String((e as Error)?.message ?? e)}`, code: classifyError(e, "agent_start_failed") };
        this.send({ t: "sse", event });
        reportTurnError("call", this.brain(), event);
      });
  }

  /** Who answers this call, as telemetry names it; nothing when settings cannot say. */
  private brain(): BrainIdent {
    if (this.boundId) return brainOf("acp", this.boundId);
    try { return brainOf("api", resolveLive().provider.id); }
    catch { return {}; }
  }

  /** The call's tools, each with its chip. Built again when the folder changes, as a folder brings its own skills. */
  private callTools(): ToolSet {
    const set = registry.tools(CHAT, this.toolSession);
    const chip = (t: Tool) => (OWN_UI.has(t.name) ? t : this.chipped(t));
    return new ToolSet(set.list.map(chip), set.onDemand?.list.map(chip));
  }

  /** A tool with its chip in the running turn, the same whichever brain calls it. */
  private chipped(t: Tool): Tool {
    return {
      ...t,
      execute: async (args, ctx) => {
        const id = randomUUID();
        const named = CHIP_ARGS.map((k) => args?.[k]).find((v) => typeof v === "string" && v);
        await this.toolEmit({ type: "tool_start", id, tool: t.name, ...(named && { summary: named }) });
        try { return await t.execute(args, ctx); } finally { await this.toolEmit({ type: "tool_done", id }); }
      },
    };
  }

  /** Relay an agent permission ask to the client (spoken + chips + inline on the
   *  tool card when toolCallId is known) and await the chosen option id; times
   *  out to "deny" so a hung decision never wedges a turn. */
  private askPermission(question: string, options: PermissionAskOption[], toolCallId?: string): Promise<string> {
    return new Promise((resolve) => {
      if (this.closed) { permissionFact("call", "cancelled"); return resolve("deny"); }
      // A cut or finished turn's late ask: its number is stale, so the client drops it,
      // and left pending here it would take the next utterance as its answer.
      if (!this.ac || this.ac.signal.aborted) { permissionFact("call", "cancelled"); return resolve(PERMISSION_CANCELLED); }
      const reqId = randomUUID();
      const PERM_TIMEOUT_MS = 120_000;
      const expiresAt = Date.now() + PERM_TIMEOUT_MS; // client renders the countdown + speaks a reminder
      // Single settle path for every outcome (answered / auto-deny / cancelled): it
      // removes the pending entry AND tells the client the ask is resolved, so the
      // chip is dismissed and a later utterance isn't mis-read as a yes/no answer.
      const settle = (optionId: string, outcome?: PermissionOutcome) => {
        if (!this.permPending.delete(reqId)) return; // already settled
        clearTimeout(timer);
        permissionFact("call", outcome ?? askOutcome(options, optionId));
        this.send({ t: "permission_resolved", reqId });
        resolve(optionId);
      };
      const timer = setTimeout(() => settle("deny", "timeout"), PERM_TIMEOUT_MS);
      this.permPending.set(reqId, settle);
      this.send({ t: "permission", reqId, question, options, expiresAt, toolCallId, turn: this.replyTurn });
    });
  }

  /** Relay an agent elicitation (login URL / input form) to the client and await
   *  the user's action. Same lifecycle discipline as askPermission: one settle
   *  path, 120s timeout → cancel, dismissed client-side via elicitation_resolved.
   *  URL elicitations also register under the agent's elicitationId so an
   *  agent-side completion (OAuth landed) auto-accepts the card. */
  private askElicitation(req: ElicitationAsk): Promise<ElicitationAnswer> {
    return new Promise((resolve) => {
      // Outside a turn only a request-scoped ask is live: ACP's scope for auth and
      // setup before any session exists. A session-scoped one then is a finished
      // turn's, and held it would take the next sentence as its answer.
      if (this.closed || this.ac?.signal.aborted || (!this.ac && !req.requestScoped)) return resolve({ action: "cancel" });
      emitFact("call", { elicitations: 1 });
      const reqId = randomUUID();
      const ELICIT_TIMEOUT_MS = 120_000;
      const expiresAt = Date.now() + ELICIT_TIMEOUT_MS;
      const settle = (a: ElicitationAnswer) => {
        if (!this.elicitPending.delete(reqId)) return; // already settled
        if (req.elicitationId) this.elicitById.delete(req.elicitationId);
        clearTimeout(timer);
        this.send({ t: "elicitation_resolved", reqId });
        resolve(a);
      };
      const timer = setTimeout(() => settle({ action: "cancel" }), ELICIT_TIMEOUT_MS);
      this.elicitPending.set(reqId, settle);
      if (req.elicitationId) this.elicitById.set(req.elicitationId, settle);
      // Unnumbered outside a turn, so the client shows it whichever turn it is on.
      this.send({ t: "elicitation", reqId, mode: req.mode, message: req.message, url: req.url, schema: req.schema, expiresAt, turn: this.ac ? this.replyTurn : undefined });
    });
  }

  /** Settle any in-flight elicitations as cancelled (turn end / teardown). */
  private cancelPendingElicitations() {
    for (const settle of [...this.elicitPending.values()]) settle({ action: "cancel" });
  }

  // ── `look` handshake ────────────────────────────────────────────────────
  /** Grab one fresh hi-res frame. SERIALIZED: the client↔server handshake has a
   *  single in-flight slot (binary frames carry no reqId), so two concurrent `look`
   *  calls (the turn-runner fans tool calls out with Promise.all) would otherwise
   *  overwrite each other's slot — the first promise would never resolve and the
   *  whole session would wedge (turnActive stuck true). Chaining makes each look
   *  wait its turn; every one resolves (frame or null on timeout). */
  private requestFrame(): Promise<Frame | null> {
    const run = () => new Promise<Frame | null>((resolve) => {
      const reqId = randomUUID();
      const timer = setTimeout(() => {
        if (this.lookPending?.reqId === reqId) { this.lookPending = null; this.awaitingLookFrame = false; resolve(null); }
      }, 4000);
      this.lookPending = { reqId, resolve: (f) => { clearTimeout(timer); resolve(f); } };
      this.awaitingLookFrame = false;
      this.send({ t: "need_frame", reqId });
    });
    const p = this.frameChain.then(run, run);
    this.frameChain = p.catch(() => {});
    return p;
  }

  // ── send / teardown ───────────────────────────────────────────────────────
  private send(m: LiveServerMsg) {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(m));
  }

  private dispose() {
    if (this.closed) return;
    this.closed = true;
    liveSockets.delete(this.hear);
    this.warmAc?.abort();
    this.ac?.abort();
    this.agentAc?.abort();
    void this.agent?.dispose();
    void this.mcp?.then((m) => m.close()).catch(() => {});
    for (const settle of [...this.permPending.values()]) settle("deny", "cancelled");
    this.cancelPendingElicitations();
    this.lookPending?.resolve(null);
    for (const r of this.bridgePending.values()) r("The session ended.");
    this.bridgePending.clear();
    try { this.ws.close(); } catch { /* already closing */ }
  }
}
