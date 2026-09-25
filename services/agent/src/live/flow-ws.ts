import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { FlowContentWire, LanguageCode, LiveServerMsg } from "@openlive/shared";
import { flowContextSchema, liveClientMsgSchema } from "@openlive/shared";
import { FlowSession as FlowStoreSession, loadSession, readFlowConfig, sessionPath, updateFlowConfig, type FlowConfig } from "@openlive/flow-store";
import { AcpBrain, LocalBrain } from "../flow/brain.js";
import { resolveLive, type ResolvedLive } from "../providers.js";
import { serveFlowMcp } from "../flow/mcp.js";
import { AcpAgent } from "../agents/acp-agent.js";
import { AgentSupervisor } from "../agents/supervisor.js";
import { flowAgentCwd, PERMISSION_CANCELLED, type Agent, type AgentMeta, type PermissionAskOption } from "../agents/index.js";
import type { McpServerWire } from "../agents/mcp-config.js";
import { isAgentId } from "@openlive/shared";
import { runFlow } from "../flow/loop.js";
import { buildFlowAcpPreamble, buildFlowPrompt } from "../flow/prompt.js";
import { consentApprove } from "../flow/approval.js";
import { ForwardOnlyInsertion, flowTools } from "../flow/tools.js";
import type { DevicePort } from "../flow/device.js";
import type { Approve, Brain, ClipboardPort, ContextProvider, FlowContext, Msg } from "../flow/types.js";
import { log } from "../log.js";

// Flow's half of the /live socket. It is a SEPARATE connection from chat's: the
// Flow runtime lives in its own renderer, and a WebSocket cannot be shared across
// renderers. But it is the same endpoint, the same schemas and the same
// permission protocol, so nothing about LiveSession changes.

const BRIDGE_TIMEOUT_MS = 8_000;
/** Perception is slower than the clipboard: OCR pays a one-off Vision warm-up of about 26 seconds per process. */
const DEVICE_TIMEOUT_MS = 40_000;
const ASK_TIMEOUT_MS = 20_000;
/** Enough of a turn to stay useful without turning the session file into a corpus. */
const PERSIST_TEXT_CAP = 20_000;
/** Pictures kept on disk per session. A screenshot is about a megabyte. */
const SESSION_ASSET_CAP = 60;

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/**
 * Cut a persisted reply back to what the voice actually said before the user cut in.
 *
 * Only ever the aborted turn's own reply: barge in before the first token and
 * the turn produced no assistant message at all, and the answer waiting above it
 * belongs to a turn the user heard in full.
 */
export function truncateToSpoken(messages: Msg[], spoken: string, from: number): void {
  for (let i = messages.length - 1; i >= from; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    m.text = spoken.trim() || undefined;
    if (!m.text && !m.toolCalls?.length) messages.splice(i, 1);
    return;
  }
}

const safeJson = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } };

/** The model-facing transcript of a stored session. Tool activity is left out:
 *  its results are stale, and a call with no result is worse than no call. */
export function transcriptOf(entries: { type: string; [k: string]: unknown }[]): Msg[] {
  const out: Msg[] = [];
  for (const e of entries) {
    if (e.type !== "message") continue;
    const text = typeof e.text === "string" ? e.text : "";
    if (!text.trim()) continue;
    out.push({ role: e.role === "assistant" ? "assistant" : "user", text });
  }
  return out;
}

/** What a coding agent is seeded with: everything before the words it is about
 *  to be sent, which reach it as the turn itself. */
export function priorTurns(messages: Msg[]): Msg[] {
  let end = messages.length;
  while (end > 0 && messages[end - 1]!.role === "user") end--;
  return messages.slice(0, end);
}

/**
 * The agent's own word for "stop asking me", most permissive first.
 *
 * Matched rather than named, because every agent calls it something different
 * and none of it is standardised. Order is the point: an agent offering both
 * "accept edits" and "bypass permissions" must land on the one that actually
 * stops the questions, whichever order it happens to list them in.
 */
const QUIET_MODES = [/bypass|yolo|full.?access|danger/i, /accept|auto/i];

export function quietModeId(meta: AgentMeta | null): string {
  const modes = meta?.modes ?? [];
  for (const pattern of QUIET_MODES) {
    const hit = modes.find((m) => pattern.test(m.id)) ?? modes.find((m) => pattern.test(m.name));
    if (hit) return hit.id;
  }
  return "";
}

/**
 * Which brain answered, written into the session header when it opens.
 *
 * Ids, never labels: the window already knows how to say "Claude Code", and a
 * file that spelled it out would be wrong the day the label changes. Recorded
 * because a transcript that cannot say who answered it cannot explain itself
 * months later, and effort is the other half of "why was that turn slow".
 */
export const brainMeta = (cfg: FlowConfig, live: () => ResolvedLive = resolveLive) => {
  if (cfg.brain.kind === "acp") return { kind: "acp", id: cfg.brain.agentId, model: cfg.brain.agentModel, effort: cfg.brain.agentEffort };
  const { provider, model, effort } = live();
  return { kind: "api", id: provider.id, model, effort: effort ?? "" };
};

/** How hard a coding agent thinks, where it exposes that as a config option. */
export const agentEffortOption = (meta: AgentMeta | null) =>
  meta?.options.find((o) => o.category === "thought_level") ?? null;

const YES_NO: PermissionAskOption[] = [
  { id: "allow", label: "Yes", kind: "allow_once" },
  { id: "deny", label: "Cancel", kind: "reject_once" },
];

export class FlowLiveSession {
  private closed = false;
  private ac: AbortController | null = null;
  private turnActive = false;
  /** An idle expiry that landed mid-turn: the transcript is the running loop's until it ends. */
  private archived = false;
  private spoken: string | null = null;
  /** Where the last finished turn starts in `messages`, while its reply may still
   *  be playing: a reply streams far faster than it is spoken, so most barge-ins
   *  land after the turn is over. -1 once it can no longer be cut. */
  private voicedFrom = -1;
  /** That turn's reply as written to the session file, its id filled in once the
   *  write lands, so a cut arriving after it can name the line it shortens. */
  private savedReply: { id: string } | null = null;
  /** Utterances that arrived mid-run: the loop drains them between turns. */
  private steering: Msg[] = [];
  /** The client's number for the latest utterance. */
  private turn: number | undefined;
  /** The number the running loop's events carry. It moves to a steering utterance
   *  only once the loop takes it in, so a cut run's closing events keep the number
   *  of the turn that was cut. A spoken answer bounced to an open ask moves it too:
   *  the client numbered that sentence, and the rest of the run is still its reply. */
  private replyTurn: number | undefined;
  private messages: Msg[] = [];
  private brain: Brain = new LocalBrain();
  /** The coding-agent brain and the MCP server publishing Flow's tools to it. */
  private agent: Agent | null = null;
  /** The model already pushed to `agent`, so a change in settings is applied
   *  without tearing the agent down and losing its session. */
  private agentModel = "";
  private mcp: { wire: McpServerWire; close(): Promise<void> } | null = null;
  /** The one permission Flow takes. Read from the config each turn, and set the
   *  moment it is given, so a yes mid-turn is not asked about again. */
  private consented = false;
  /** Rebuilt every turn, and read by both brains. */
  private approve: Approve = async () => ({});
  /** What the coding agent says it can be set to, as of its last session. */
  private agentMeta: AgentMeta | null = null;
  /** The effort already pushed to `agent`, kept apart from the model for the
   *  same reason: it is an option the agent names, not one OpenLive knows. */
  private agentEffort = "";
  private bridgePending = new Map<string, (out: string) => void>();
  private permPending = new Map<string, (optionId: string) => void>();
  private store: FlowStoreSession | null = null;
  /** Pictures written for the session in hand, against SESSION_ASSET_CAP. */
  private assetCount = 0;
  private writing: Promise<void> = Promise.resolve();
  private opening: Promise<FlowStoreSession> | null = null;
  /** The metadata the desktop captured as the user spoke, used until a fresher read lands. */
  private lastContext: FlowContext | null = null;
  /** The language the last utterance was spoken in; the next turn answers in it. */
  private lang: LanguageCode | undefined;

  private insert = new ForwardOnlyInsertion(
    (id, chunk) => this.bridge("flow_insert", JSON.stringify({ id, chunk })).then(() => {}),
    (id) => this.bridge("flow_insert_end", id).then(() => {}),
  );

  private clipboard: ClipboardPort = {
    read: () => this.bridge("clipboard_read"),
    write: async (text) => { await this.bridge("clipboard_write", text); },
  };

  /**
   * Perception and control, over the same bridge as the clipboard.
   *
   * The addon lives in the Electron main process, so every call is one round
   * trip named by `fn`. An error comes back as an error, never as an empty
   * result: a tool that returns a black frame is worse than one that refuses.
   */
  private device: DevicePort = {
    capabilities: () => this.deviceCall("capabilities"),
    displays: () => this.deviceCall("displays"),
    capture: (target) => this.deviceCall("capture", target),
    shotToScreen: (shot, point) => this.deviceCall("shot_to_screen", { shot, point }),
    recognizeText: (png, shot) => this.deviceCall("recognize_text", { png, shot }),
    windows: () => this.deviceCall("windows"),
    foreground: () => this.deviceCall("foreground"),
    cameraFrame: () => this.deviceCall("camera_frame"),
    control: (action) => this.deviceCall("control", action),
    shell: (command) => this.deviceCall("shell", { command }),
  };

  // Declared after `device`: a class field is initialized in source order.
  private tools = flowTools({ device: this.device });

  private context: ContextProvider = {
    capture: async (signal) => {
      if (signal.aborted) return this.lastContext;
      const parsed = flowContextSchema.safeParse(safeJson(await this.bridge("flow_context")));
      if (parsed.success) this.lastContext = parsed.data;
      return this.lastContext;
    },
  };

  constructor(private ws: WebSocket) {
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) this.onText(data.toString()).catch((e) => log.error("flow", "text:", e));
    });
    ws.on("close", () => this.dispose());
    ws.on("error", () => this.dispose());
  }

  // ── inbound ───────────────────────────────────────────────────────────────

  private async onText(str: string) {
    let msg;
    try { msg = liveClientMsgSchema.parse(JSON.parse(str)); } catch { return; }
    switch (msg.t) {
      case "flow_text": {
        // An ask is awaiting the user. The orb answers its own chip, so a numbered
        // sentence landing here was said before the ask reached it, and the orb drops
        // an older turn's ask: refused, the sentence steers the turn instead. Only an
        // orb that numbers no turns shows every ask, so only its sentence bounces back.
        if (this.permPending.size) {
          if (msg.turn === undefined) { this.send({ t: "modal_voice_answer", text: msg.text }); return; }
          this.cancelPendingPermissions();
        }
        if (msg.context) this.lastContext = msg.context;
        this.lang = msg.lang;
        this.turn = msg.turn;
        return this.onUtterance(msg.text);
      }
      case "flow_cancel":
        // The orb holds its barge-in while it shows an ask, so a cancel is Stop,
        // close, or a barge-in over an ask it never showed: each refuses the ask.
        this.cancelPendingPermissions();
        if (this.turnActive) this.spoken = msg.spoken ?? "";
        else if (!msg.close && msg.spoken != null && this.voicedFrom >= 0) {
          truncateToSpoken(this.messages, msg.spoken, this.voicedFrom);
          // The file is append-only, so the reply stays whole there and a `cut`
          // naming it tells every reader to keep only what was heard.
          const saved = this.savedReply, text = msg.spoken.trim();
          if (saved) this.write(async () => { if (saved.id) await this.persist("cut", { target: saved.id, text }); });
        }
        this.voicedFrom = -1;
        this.ac?.abort();
        return;
      case "tool_bridge_result": {
        const r = this.bridgePending.get(msg.reqId);
        if (r) { this.bridgePending.delete(msg.reqId); r(msg.output); }
        return;
      }
      case "permission_response":
        this.permPending.get(msg.reqId)?.(msg.optionId);
        return;
      case "flow_resume":
        return this.resumeSession(msg.sessionId);
      case "flow_new":
        return this.newSession();
      case "control":
        if (msg.action === "end") this.dispose();
        return;
      default:
        return;
    }
  }

  private onUtterance(text: string) {
    if (!text.trim() || this.closed) return;
    const m: Msg = { role: "user", text };
    this.write(() => this.persist("message", { role: "user", text }));
    if (this.turnActive) { this.steering.push(m); return; }
    this.messages.push(m);
    void this.run();
  }

  // ── the turn ──────────────────────────────────────────────────────────────

  private async run() {
    this.turnActive = true;
    this.voicedFrom = -1;
    const startedAt = this.messages.length;
    this.replyTurn = this.turn;
    const ac = new AbortController();
    this.ac = ac;
    const cfg = readFlowConfig();
    this.consented = cfg.consent.granted;
    this.approve = consentApprove({
      granted: () => this.consented,
      timeoutMs: ASK_TIMEOUT_MS,
      ask: (question, signal) => this.askPermission(question, signal),
      remember: () => this.rememberConsent(),
    });
    try {
      for await (const event of runFlow({
        brain: await this.brainFor(cfg, ac.signal),
        tools: this.tools,
        messages: this.messages,
        signal: ac.signal,
        insert: this.insert,
        clipboard: this.clipboard,
        context: this.context,
        approve: (req, signal) => this.approve(req, signal),
        getSystemPrompt: () => buildFlowPrompt({ tools: this.tools, lang: this.lang }),
        pollSteering: () => {
          if (this.steering.length) this.replyTurn = this.turn;
          return this.steering.splice(0);
        },
      })) {
        this.send({ t: "flow", event, turn: this.replyTurn });
        this.write(() => this.record(event));
      }
    } catch (e) {
      log.error("flow", "turn:", e);
      // Mostly a coding agent that would not start, and its reason is the fix.
      const message = (e instanceof Error && e.message.slice(0, 400)) || "That turn failed.";
      const aborted = ac.signal.aborted;
      this.send({ t: "flow", event: { type: "error", message, aborted }, turn: this.replyTurn });
      this.send({ t: "flow", event: { type: "done", reason: aborted ? "aborted" : "error" }, turn: this.replyTurn });
    } finally {
      this.turnActive = false;
      this.ac = null;
      // An ask left hanging by a cancelled turn must be settled, or the client's
      // chip stays up and swallows the user's next sentence as a yes/no.
      this.cancelPendingPermissions();
      if (ac.signal.aborted && this.spoken !== null) truncateToSpoken(this.messages, this.spoken, startedAt);
      else if (!ac.signal.aborted) this.voicedFrom = startedAt;
      this.spoken = null;
      const last = this.messages[this.messages.length - 1];
      this.savedReply = null;
      if (last?.role === "assistant" && (last.text || last.toolCalls?.length)) {
        const saved = { id: "" };
        this.savedReply = saved;
        this.write(async () => {
          try { saved.id = (await (await this.session()).append("message", { role: "assistant", text: last.text?.slice(0, PERSIST_TEXT_CAP) ?? "" })).id; }
          catch (e) { log.error("flow", "persist:", e); }
        });
      }
      if (this.archived) { this.archived = false; this.rollSession(); }
      if (this.steering.length && !this.closed) {
        this.messages.push(...this.steering.splice(0));
        void this.run();
      }
    }
  }

  /** Every write to the session file, in the order the turn produced it. Saving
   *  a screenshot takes longer than appending a line, and a transcript whose
   *  lines overtook each other is not a transcript. */
  private write(job: () => Promise<void>): void {
    this.writing = this.writing.then(job, job);
  }

  /** The session file mirrors the turn; the transcript in memory is the model's copy. */
  private async record(event: { type: string } & Record<string, unknown>): Promise<void> {
    if (event.type === "context") return this.persist("context", { context: event.context });
    if (event.type === "tool_call") return this.persist("tool_call", { callId: event.id, name: event.name, args: event.args });
    if (event.type === "tool_result") {
      const assets = await this.saveAssets(String(event.id), event.content as FlowContentWire[]);
      return this.persist("tool_result", {
        callId: event.id, name: event.name, isError: event.isError,
        ...(assets.length ? { assets } : {}),
      });
    }
  }

  /**
   * What a tool actually saw, kept beside the transcript.
   *
   * The pictures never enter the JSONL, only their paths, so a session file stays
   * a file you can read. They stop being written past `SESSION_ASSET_CAP`
   * because a conversation that clicks around an app for an hour would otherwise
   * fill the person's home directory with screenshots nobody asked for.
   */
  private async saveAssets(callId: string, content: FlowContentWire[] | undefined): Promise<string[]> {
    const images = (content ?? []).filter((c): c is Extract<FlowContentWire, { type: "image" }> => c.type === "image");
    if (!images.length || this.assetCount >= SESSION_ASSET_CAP) return [];
    try {
      const session = await this.session();
      return images.slice(0, SESSION_ASSET_CAP - this.assetCount).map((img, i) => {
        this.assetCount++;
        return session.writeAsset(`${callId}-${i}.${EXT[img.mime] ?? "png"}`, Buffer.from(img.data, "base64"));
      });
    } catch (e) {
      log.error("flow", "asset:", e);
      return [];
    }
  }

  private async persist(type: "message" | "context" | "tool_call" | "tool_result" | "cut", data: Record<string, unknown>): Promise<void> {
    try { await (await this.session()).append(type, data); }
    catch (e) { log.error("flow", "persist:", e); }
  }

  /**
   * Continue an archived session. The next utterance appends to that file rather
   * than to a fresh one, and the brain is handed the turns already in it, so
   * "carry on from here" carries the conversation and not just the file.
   *
   * A turn in flight keeps what it has: swapping the transcript under a running
   * loop would leave the reply parented onto the wrong session.
   */
  private async resumeSession(sessionId: string): Promise<void> {
    if (this.closed || this.turnActive) return;
    const path = sessionPath(sessionId);
    const loaded = path ? loadSession(sessionId) : null;
    if (!loaded) return;
    try {
      await this.store?.archive();
      this.store = await FlowStoreSession.resume(
        path,
        undefined,
        { idleMs: readFlowConfig().idleWindowMs, onIdle: () => this.onStoreIdle() },
      );
      this.opening = Promise.resolve(this.store);
      this.messages = transcriptOf(loaded.entries);
      this.assetCount = loaded.assets.length;
      // A coding agent keeps its own conversation, so it has to be rebuilt and
      // seeded with this one, or it answers from the session it was last in.
      void this.dropAgent();
    } catch (e) {
      log.error("flow", "resume:", e);
    }
  }

  /**
   * Archive the current session now rather than at idle, so the next utterance
   * opens a fresh one. A turn in flight keeps its session, as with a resume.
   */
  private async newSession(): Promise<void> {
    if (this.closed || this.turnActive) return;
    try { await this.store?.archive(); }
    catch (e) { log.error("flow", "new session:", e); }
    this.rollSession();
  }

  /**
   * The rolling session went idle and archived itself; the next utterance opens
   * a fresh one with a fresh transcript.
   *
   * `runFlow` holds the transcript array it was handed, so replacing it under a
   * turn in flight would leave that turn appending into an orphan and its reply
   * unpersisted. A turn in flight keeps both the array and the file it started
   * writing into, and the swap happens when it ends.
   */
  private onStoreIdle(): void {
    if (this.turnActive) { this.archived = true; return; }
    this.rollSession();
  }

  /** Let go of the archived session, its transcript and the coding agent that
   *  remembers it, so the next utterance opens a fresh one. */
  private rollSession(): void {
    this.store = null;
    this.opening = null;
    this.messages = [];
    this.voicedFrom = -1;
    this.assetCount = 0;
    void this.dropAgent();
  }

  /** One rolling session. On idle expiry it archives itself and the next utterance
   *  opens a fresh one with a fresh transcript. */
  private session(): Promise<FlowStoreSession> {
    if (this.store) return Promise.resolve(this.store);
    if (!this.opening) {
      const cfg = readFlowConfig();
      this.opening = FlowStoreSession.open({
        idleMs: cfg.idleWindowMs,
        meta: { mode: "flow", brain: brainMeta(cfg) },
        onIdle: () => this.onStoreIdle(),
      }).then((s) => { this.store = s; return s; });
      this.opening.catch(() => { this.opening = null; });
    }
    return this.opening;
  }

  // ── client handshakes ─────────────────────────────────────────────────────

  /** Run an OS action on the user's machine and await its result. */
  private bridge(op: "clipboard_read" | "clipboard_write" | "flow_insert" | "flow_insert_end" | "flow_context" | "flow_device", arg?: string, timeoutMs = BRIDGE_TIMEOUT_MS): Promise<string> {
    if (this.closed) return Promise.resolve("");
    return new Promise((resolve) => {
      const reqId = randomUUID();
      const timer = setTimeout(() => { if (this.bridgePending.delete(reqId)) resolve(""); }, timeoutMs);
      this.bridgePending.set(reqId, (out) => { clearTimeout(timer); resolve(out); });
      this.send({ t: "tool_bridge", reqId, op, arg, turn: this.replyTurn });
    });
  }

  /**
   * The brain the user picked.
   *
   * A coding agent gets Flow's tool set as an MCP server built from the SAME
   * `Tool[]` the built-in brain runs, through the same approval hook, so
   * swapping the brain cannot change what Flow can do or what it asks about.
   */
  private async brainFor(cfg: FlowConfig, signal: AbortSignal): Promise<Brain> {
    const agentId = cfg.brain.kind === "acp" && isAgentId(cfg.brain.agentId) ? cfg.brain.agentId : null;
    if (!agentId) {
      if (this.agent) void this.dropAgent();
      return this.brain instanceof LocalBrain ? this.brain : (this.brain = new LocalBrain());
    }
    if (this.agent && this.brain.id === agentId) {
      await this.applyAgentModel(cfg.brain.agentModel);
      await this.applyAgentEffort(cfg.brain.agentEffort);
      return this.brain;
    }
    void this.dropAgent();
    this.mcp ??= await serveFlowMcp({
      tools: this.tools,
      ctx: () => ({ signal: this.ac?.signal ?? signal, context: this.lastContext, insert: this.insert, clipboard: this.clipboard }),
      approve: (req, s) => this.approve(req, s),
      // An agent brain drives these tools itself, so the session only learns
      // what it did if the server says so.
      onCall: (event) => { this.write(() => this.record(event)); },
    });
    const wire = this.mcp.wire;
    const agent = new AgentSupervisor(
      (ask) => new AcpAgent(agentId, ask, {
        cwd: flowAgentCwd(),
        mcpServers: [wire],
        preamble: buildFlowAcpPreamble({ tools: this.tools }),
        onMeta: (meta) => { this.agentMeta = meta; },
      }),
      (question, options, toolCallId) => this.answerForAgent(question, options, toolCallId, signal),
      { startMs: 60_000 },
    );
    try { await agent.start(signal); }
    catch (e) { await agent.dispose().catch(() => {}); throw e; }
    agent.seed(priorTurns(this.messages));
    this.agent = agent;
    this.agentModel = "";
    this.agentEffort = "";
    await this.applyQuietMode();
    await this.applyAgentModel(cfg.brain.agentModel);
    await this.applyAgentEffort(cfg.brain.agentEffort);
    return (this.brain = new AcpBrain(agent, () => this.lang));
  }

  /** Never throws: an agent that will not take a model still answers on its own. */
  private async applyAgentModel(modelId: string): Promise<void> {
    if (!modelId || modelId === this.agentModel) return;
    this.agentModel = modelId;
    await this.agent?.setModel?.(modelId);
  }

  /** How hard the coding agent thinks, as the agent itself names the setting.
   *  An agent with no such option keeps whatever it was already on. */
  private async applyAgentEffort(valueId: string): Promise<void> {
    if (!valueId || valueId === this.agentEffort) return;
    const option = agentEffortOption(this.agentMeta);
    if (!option?.values.some((v) => v.id === valueId)) return;
    this.agentEffort = valueId;
    await this.agent?.setOption?.(option.id, valueId);
  }

  /**
   * Put the coding agent in the mode that does not stop to ask.
   *
   * Flow took one permission, in onboarding, for everything it does. An agent
   * left in its own "ask me every time" mode would go on asking underneath that
   * — out loud, mid-sentence — which is the whole thing the person said no to.
   * An agent with no such mode is left alone; its asks are answered for it.
   */
  private async applyQuietMode(): Promise<void> {
    if (!this.consented) return;
    const modeId = quietModeId(this.agentMeta);
    if (modeId && modeId !== this.agentMeta?.currentModeId) await this.agent?.setMode?.(modeId);
  }

  /**
   * The agent asked for permission anyway. Consent already covers it, so the
   * broadest "yes" it offered is the answer, and `allow_always` is preferred so
   * it stops asking about that tool for the rest of the session.
   */
  private answerForAgent(question: string, options: PermissionAskOption[], toolCallId: string | undefined, signal: AbortSignal): Promise<string> {
    if (this.consented) {
      const allow = options.find((o) => o.kind === "allow_always") ?? options.find((o) => !o.kind?.startsWith("reject"));
      if (allow) return Promise.resolve(allow.id);
    }
    return this.ask(question, this.ac?.signal ?? signal, options, toolCallId).then((id) => id || PERMISSION_CANCELLED);
  }

  private async dropAgent(): Promise<void> {
    const agent = this.agent;
    this.agent = null;
    this.agentModel = "";
    try { await agent?.dispose(); } catch { /* it is going away either way */ }
  }

  /** Consent, once, for the life of this machine. A failed write still counts
   *  for this session: the person said yes, and asking again because a file
   *  would not open is worse than forgetting it at the next launch. */
  private async rememberConsent(): Promise<void> {
    this.consented = true;
    try { await updateFlowConfig((cur) => ({ ...cur, consent: { granted: true, at: new Date().toISOString() } })); }
    catch (e) { log.error("flow", "consent:", e); }
  }

  /** The same permission protocol chat uses: chips on the orb, spoken yes/no. */
  private askPermission(question: string, signal: AbortSignal): Promise<boolean> {
    return this.ask(question, signal, YES_NO).then((id) => id === "allow");
  }

  /** Resolves the option the user picked, or "" when they refused, ran out of time or cut in. */
  private ask(question: string, signal: AbortSignal, options: PermissionAskOption[], toolCallId?: string): Promise<string> {
    return new Promise((resolve) => {
      // A finished turn's late ask is refused: the client drops it, and left pending
      // here it would take the next utterance as its answer.
      if (this.closed || signal.aborted || !this.turnActive) return resolve("");
      const reqId = randomUUID();
      const settle = (optionId: string) => {
        if (!this.permPending.delete(reqId)) return;
        signal.removeEventListener("abort", onAbort);
        this.send({ t: "permission_resolved", reqId });
        resolve(optionId);
      };
      const onAbort = () => settle("");
      signal.addEventListener("abort", onAbort, { once: true });
      this.permPending.set(reqId, (optionId) => settle(options.some((o) => o.id === optionId && !o.kind?.startsWith("reject")) ? optionId : ""));
      this.send({ t: "permission", reqId, question, options, expiresAt: Date.now() + ASK_TIMEOUT_MS, ...(toolCallId ? { toolCallId } : {}), turn: this.replyTurn });
    });
  }

  private async deviceCall<T>(fn: string, args?: unknown): Promise<T> {
    const raw = await this.bridge("flow_device", JSON.stringify({ fn, args }), DEVICE_TIMEOUT_MS);
    if (!raw) throw new Error(`The machine did not answer in time (${fn}).`);
    // Anything that is not the envelope is the main process answering in prose.
    const reply = safeJson(raw) as { value?: T; error?: string } | null;
    if (!reply) throw new Error(raw.slice(0, 400));
    if (reply.error) throw new Error(reply.error);
    return reply.value as T;
  }

  private cancelPendingPermissions() {
    for (const settle of [...this.permPending.values()]) settle("deny");
  }

  private send(m: LiveServerMsg) {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(m));
  }

  private dispose() {
    if (this.closed) return;
    this.closed = true;
    this.ac?.abort();
    this.cancelPendingPermissions();
    for (const [reqId, r] of [...this.bridgePending]) { this.bridgePending.delete(reqId); r(""); }
    void this.dropAgent();
    void this.mcp?.close().catch(() => {});
    void this.store?.archive().catch(() => {});
  }
}
