import { randomUUID } from "node:crypto";
import path from "node:path";
import type { WebSocket } from "ws";
import type { FlowContentWire, LanguageCode, LiveServerMsg, ToolCallState } from "@openlive/shared";
import { classifyError, flowContextSchema, liveClientMsgSchema } from "@openlive/shared";
import { FlowSession as FlowStoreSession, flowBrain, loadSession, readFlowConfig, sessionPath, updateFlowConfig, type FlowConfig } from "@openlive/flow-store";
import { AcpBrain, LocalBrain } from "../flow/brain.js";
import { resolveLive, type ResolvedLive } from "../providers.js";
import { serveMcp } from "../capabilities/mcp.js";
import { registry } from "../capabilities/registry.js";
import { FLOW } from "../capabilities/profiles.js";
import { bridgedDevice, DEVICE_TIMEOUT_MS } from "../capabilities/device.js";
import { AcpAgent } from "../agents/acp-agent.js";
import { AgentSupervisor } from "../agents/supervisor.js";
import { flowAgentCwd, PERMISSION_CANCELLED, type Agent, type AgentMeta, type PermissionAskOption } from "../agents/index.js";
import { emitEvent, emitFact } from "../telemetry/emit.js";
import { askOutcome, brainOf, permissionFact, toolTally, reportReply, reportTurnError, TurnTimer, type Brain as BrainIdent } from "../telemetry/facts.js";
import type { McpServerWire } from "../agents/mcp-config.js";
import { isAgentId } from "@openlive/shared";
import { runFlow } from "../flow/loop.js";
import { buildFlowAcpPreamble } from "../flow/prompt.js";
import { isDeclined, isUnanswered } from "../capabilities/approval.js";
import { ForwardOnlyInsertion } from "../capabilities/text.js";
import type { Approve, ContextProvider, FlowContext, Session } from "../capabilities/types.js";
import type { Brain, Msg } from "../flow/types.js";
import { log } from "../log.js";
import { cancelledText, sentAside } from "../turn.js";

// Flow's half of the /live socket. It is a SEPARATE connection from chat's: the
// Flow runtime lives in its own renderer, and a WebSocket cannot be shared across
// renderers. But it is the same endpoint, the same schemas and the same
// permission protocol, so nothing about LiveSession changes.

const BRIDGE_TIMEOUT_MS = 8_000;
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

/** Every request of a stopped run, from the utterances that started it to the
 *  ones it drained, so neither brain carries one out on a later turn. Returns
 *  how many it marked. */
export function markCancelled(messages: Msg[], from: number): number {
  let i = from, n = 0;
  while (i > 0 && messages[i - 1]!.role === "user") i--;
  for (; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "user") { m.text = cancelledText(m.text); n++; }
  }
  return n;
}

const safeJson = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } };

/** The model-facing transcript of a stored session. Tool activity is left out:
 *  its results are stale, and a call with no result is worse than no call. */
export function transcriptOf(entries: { type: string; [k: string]: unknown }[]): Msg[] {
  const out: Msg[] = [];
  for (const e of entries) {
    if (e.type === "cancel") {
      let i = out.length;
      while (i > 0 && out[i - 1]!.role === "user") i--;
      for (const m of out.slice(i, i + Number(e.n))) if (m.role === "user") m.text = cancelledText(m.text);
      continue;
    }
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
  const brain = flowBrain(cfg);
  if (brain.kind === "acp") return { kind: "acp", id: brain.agentId, model: brain.agentModel, effort: brain.agentEffort };
  const { provider, model, effort } = live();
  return { kind: "api", id: provider.id, model, effort: effort ?? "" };
};

/** The brain as telemetry names it; nothing when settings cannot say. */
const flowIdent = (cfg: FlowConfig): BrainIdent => {
  try { const { kind, id } = brainMeta(cfg); return brainOf(kind === "acp" ? "acp" : "api", id); }
  catch { return {}; }
};

/** How hard a coding agent thinks, where it exposes that as a config option. */
export const agentEffortOption = (meta: AgentMeta | null) =>
  meta?.options.find((o) => o.category === "thought_level") ?? null;

/** An argument whose name says it is a secret is never written down. */
const SECRET_ARG = /key|token|secret|passw|auth|cookie|credential/i;
const ARG_CAP = 200;

/**
 * A coding agent's own tool call as Flow shows and keeps it: the kind (the
 * orb's verb) and the file it touches, relative to where the agent runs. The
 * title is left out, since for a command it is the command line itself.
 */
export function agentToolEntry(call: ToolCallState, cwd: string) {
  const file = call.locations[0]?.path;
  const rel = file && path.relative(cwd, path.resolve(cwd, file));
  const target = !file ? "" : rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : path.basename(file);
  const raw = call.rawInputJson ? safeJson(call.rawInputJson) : null;
  const args: Record<string, unknown> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (SECRET_ARG.test(k)) continue;
      if (typeof v === "string") args[k] = v.length > ARG_CAP ? `${v.slice(0, ARG_CAP)}…` : v;
      else if (typeof v === "number" || typeof v === "boolean") args[k] = v;
    }
  }
  return { kind: call.kind, target, args };
}

const YES_NO: PermissionAskOption[] = [
  { id: "allow", label: "Yes", kind: "allow_once" },
  { id: "deny", label: "Cancel", kind: "reject_once" },
];

export class FlowLiveSession {
  private closed = false;
  private ac: AbortController | null = null;
  private turnActive = false;
  /** The coding agent's ids for its calls to Flow's tools: this turn's, and every
   *  stopped turn's, whose calls are refused should they land late. */
  private turnHosted = new Set<string>();
  private deadHosted = new Set<string>();
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
   *  of the turn that was cut. */
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
  /** What the coding agent took to start, 0 in API mode. */
  private agentStartMs = 0;
  /** The brain the running turn started on, for what it reports. */
  private ident: BrainIdent = {};
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
  /** The orb only showed the last utterance's answer, so the session file must not say it was spoken. */
  private quiet = false;

  private insert = new ForwardOnlyInsertion(
    (id, chunk) => this.bridge("flow_insert", JSON.stringify({ id, chunk })).then(() => {}),
    (id) => this.bridge("flow_insert_end", id).then(() => {}),
  );

  private context: ContextProvider = {
    capture: async (signal) => {
      if (signal.aborted) return this.lastContext;
      const parsed = flowContextSchema.safeParse(safeJson(await this.bridge("flow_context")));
      if (parsed.success) this.lastContext = parsed.data;
      return this.lastContext;
    },
  };

  /**
   * What Flow's tools reach, all of it over the same bridge as the clipboard.
   *
   * The addon lives in the Electron main process, so every device call is one
   * round trip named by `fn`. An error comes back as an error, never as an empty
   * result: a tool that returns a black frame is worse than one that refuses.
   */
  private toolSession: Session = {
    foreground: this.context,
    insert: this.insert,
    clipboard: {
      read: () => this.bridge("clipboard_read"),
      write: (text) => this.bridge("clipboard_write", text),
    },
    device: bridgedDevice((arg) => this.bridge("flow_device", arg, DEVICE_TIMEOUT_MS)),
  };

  // Declared after `toolSession`: a class field is initialized in source order.
  private tools = registry.tools(FLOW, this.toolSession);
  private tally = toolTally("flow");

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
        // An ask may be awaiting the user. The orb answers its own chip, so a sentence
        // landing here was said before the ask reached it, and the orb drops an older
        // turn's ask: refused, the sentence steers the turn instead.
        this.cancelPendingPermissions();
        if (msg.context) this.lastContext = msg.context;
        this.lang = msg.lang;
        this.quiet = !!msg.quiet;
        this.turn = msg.turn;
        return this.onUtterance(msg.text, msg.wordsAt, msg.speaker, msg.aside);
      }
      case "flow_cancel":
        // The orb holds its barge-in while it shows an ask, so a cancel is Stop,
        // close, or a barge-in over an ask it never showed: each refuses the ask.
        this.cancelPendingPermissions();
        if (this.turnActive) this.spoken = msg.spoken ?? "";
        else if (msg.spoken != null && this.voicedFrom >= 0) {
          truncateToSpoken(this.messages, msg.spoken, this.voicedFrom);
          this.agent?.cut?.(msg.spoken);
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

  private onUtterance(text: string, wordsAt?: number[], speaker?: string, aside?: boolean) {
    if (!text.trim() || this.closed) return;
    const m: Msg = { role: "user", text: aside ? sentAside(text) : text };
    this.write(() => this.persist("message", { role: "user", text, ...(wordsAt && { wordsAt }), ...(speaker && { speaker }) }));
    if (this.turnActive) { this.steering.push(m); emitFact("flow", { steered: 1 }); return; }
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
    this.ident = flowIdent(cfg);
    this.approve = this.freshApprove();
    const timer = new TurnTimer();
    let finished = false;
    try {
      for await (const event of runFlow({
        brain: await this.brainFor(cfg, ac.signal),
        tools: this.tools,
        messages: this.messages,
        signal: ac.signal,
        session: this.toolSession,
        approve: (req, signal) => this.approve(req, signal),
        getSystemPrompt: () => FLOW.prompt(this.tools.list, this.lang),
        tally: this.tally,
        pollSteering: () => {
          // A new request gets its own answer: a no to the last one is not a no to it.
          if (this.steering.length) { this.replyTurn = this.turn; this.approve = this.freshApprove(); }
          return this.steering.splice(0);
        },
      })) {
        this.send({ t: "flow", event, turn: this.replyTurn });
        if (event.type === "text_delta") timer.firstText();
        else if (event.type === "error" && !event.aborted) reportTurnError("flow", this.ident, event);
        else if (event.type === "done") finished = event.reason !== "error" && event.reason !== "aborted";
        const stopped = ac.signal.aborted;
        this.write(() => this.record(event, stopped));
      }
    } catch (e) {
      log.error("flow", "turn:", e);
      // Mostly a coding agent that would not start, and its reason is the fix.
      const message = (e instanceof Error && e.message.slice(0, 400)) || "That turn failed.";
      const aborted = ac.signal.aborted;
      const code = classifyError(e, this.ident.brain_kind === "acp" ? "agent_start_failed" : "other");
      this.send({ t: "flow", event: { type: "error", message, aborted, code }, turn: this.replyTurn });
      this.send({ t: "flow", event: { type: "done", reason: aborted ? "aborted" : "error" }, turn: this.replyTurn });
      if (!aborted) reportTurnError("flow", this.ident, { code, message });
    } finally {
      emitFact("flow", {
        ...this.ident, turns: 1, consent: this.consented, agent_start_ms: this.agentStartMs, ...(this.lang && { lang: this.lang }),
        ...(this.quiet && { quiet_turns: 1 }), ...timer.timings(finished),
      });
      if (finished) reportReply("flow");
      this.turnActive = false;
      this.ac = null;
      // An ask left hanging by a cancelled turn must be settled, or the client's
      // chip stays up and swallows the user's next sentence as a yes/no.
      this.cancelPendingPermissions();
      for (const id of ac.signal.aborted ? this.turnHosted : []) this.deadHosted.add(id);
      this.turnHosted.clear();
      if (ac.signal.aborted) {
        const n = markCancelled(this.messages, startedAt);
        this.write(() => this.persist("cancel", { n }));
      }
      if (ac.signal.aborted && this.spoken !== null) { truncateToSpoken(this.messages, this.spoken, startedAt); this.agent?.cut?.(this.spoken, true); }
      else if (!ac.signal.aborted) this.voicedFrom = startedAt;
      this.spoken = null;
      const last = this.messages[this.messages.length - 1];
      this.savedReply = null;
      if (last?.role === "assistant" && (last.text || last.toolCalls?.length)) {
        const saved = { id: "" }, quiet = this.quiet;
        this.savedReply = saved;
        this.write(async () => {
          try { saved.id = (await (await this.session()).append("message", { role: "assistant", text: last.text?.slice(0, PERSIST_TEXT_CAP) ?? "", ...(quiet && { quiet }) })).id; }
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

  private freshApprove(): Approve {
    return FLOW.approval({
      granted: () => this.consented,
      onResult: (outcome) => emitEvent("flow_consent_result", { outcome, ...(this.ident.brain_kind && { brain_kind: this.ident.brain_kind }) }),
      timeoutMs: ASK_TIMEOUT_MS,
      ask: (question, signal) => this.askPermission(question, signal),
      remember: () => this.rememberConsent(),
    });
  }

  /** Every write to the session file, in the order the turn produced it. Saving
   *  a screenshot takes longer than appending a line, and a transcript whose
   *  lines overtook each other is not a transcript. */
  private write(job: () => Promise<void>): void {
    this.writing = this.writing.then(job, job);
  }

  /** The session file mirrors the turn; the transcript in memory is the model's copy.
   *  `stopped`: the turn was already stopped when the event came, so a call that
   *  did not complete was stopped, not broken. */
  private async record(event: { type: string } & Record<string, unknown>, stopped: boolean): Promise<void> {
    if (event.type === "context") return this.persist("context", { context: event.context });
    if (event.type === "tool_call") return this.persist("tool_call", { callId: event.id, name: event.name, args: event.args });
    if (event.type === "tool_result") {
      const assets = await this.saveAssets(String(event.id), event.content as FlowContentWire[]);
      const said = (is: (text: string) => boolean) => (event.content as FlowContentWire[] | undefined)?.some((c) => c.type === "text" && is(c.text));
      const cancelled = !!event.isError && stopped;
      const declined = !cancelled && said(isDeclined), unanswered = !cancelled && said(isUnanswered);
      return this.persist("tool_result", {
        callId: event.id, name: event.name, isError: event.isError,
        ...(cancelled && { cancelled }),
        ...(declined && { declined }),
        ...(unanswered && { unanswered }),
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

  private async persist(type: "message" | "context" | "tool_call" | "tool_result" | "cut" | "cancel", data: Record<string, unknown>): Promise<void> {
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
    const brain = flowBrain(cfg);
    const agentId = brain.kind === "acp" && isAgentId(brain.agentId) ? brain.agentId : null;
    if (!agentId) {
      if (this.agent) void this.dropAgent();
      return this.brain instanceof LocalBrain ? this.brain : (this.brain = new LocalBrain());
    }
    if (this.agent && this.brain.id === agentId) {
      await this.applyAgentModel(brain.agentModel);
      await this.applyAgentEffort(brain.agentEffort);
      return this.brain;
    }
    void this.dropAgent();
    this.mcp ??= await serveMcp({
      tools: this.tools,
      // A call arriving outside a turn is refused, as the built-in brain never makes
      // one, and so is one a stopped turn made that lands in the next.
      ctx: (agentCallId) => ({
        ...this.toolSession,
        signal: (agentCallId && this.deadHosted.has(agentCallId) ? null : this.ac?.signal) ?? AbortSignal.abort(),
        context: this.lastContext,
      }),
      approve: (req, s) => this.approve(req, s),
      tally: this.tally,
      // An agent brain drives these tools itself, so the session only learns
      // what it did if the server says so.
      // The orb shows a tool at work whichever brain called it.
      onCall: (event) => {
        if (event.type === "tool_call") this.send({ t: "flow", event: { type: "tool_start", id: String(event.id), name: String(event.name) }, turn: this.replyTurn });
        const stopped = !this.ac || this.ac.signal.aborted;
        this.write(() => this.record(event, stopped));
      },
    });
    const wire = this.mcp.wire;
    const agent = new AgentSupervisor(
      (ask) => new AcpAgent(agentId, ask, {
        cwd: flowAgentCwd(),
        mcpServers: [wire],
        preamble: buildFlowAcpPreamble({ tools: this.tools.list }),
        onMeta: (meta) => { this.agentMeta = meta; },
      }),
      (question, options, toolCallId) => this.answerForAgent(question, options, toolCallId, signal),
      { startMs: 60_000 },
      "flow",
    );
    const startedAt = performance.now();
    try { await agent.start(signal); }
    catch (e) { await agent.dispose().catch(() => {}); throw e; }
    this.agentStartMs = Math.round(performance.now() - startedAt);
    agent.seed(priorTurns(this.messages));
    this.agent = agent;
    this.agentModel = "";
    this.agentEffort = "";
    await this.applyQuietMode();
    await this.applyAgentModel(brain.agentModel);
    await this.applyAgentEffort(brain.agentEffort);
    return (this.brain = new AcpBrain(agent, () => this.lang, (call, settled) => this.onAgentTool(call, settled), (id) => this.turnHosted.add(id)));
  }

  /** The agent's own tools, shown and kept as Flow's are. */
  private onAgentTool(call: ToolCallState, settled: boolean): void {
    const { kind, target, args } = agentToolEntry(call, flowAgentCwd());
    const shown = { kind, ...(target && { target }) };
    if (!settled) { this.send({ t: "flow", event: { type: "tool_start", id: call.id, name: kind, ...shown }, turn: this.replyTurn }); return; }
    emitFact("flow", { agent_tools: 1, ...(call.status === "failed" && { agent_tools_failed: 1 }) });
    const cancelled = call.status === "canceled" || (call.status !== "completed" && !!this.ac?.signal.aborted);
    this.write(async () => {
      await this.persist("tool_call", { callId: call.id, name: kind, ...shown, args });
      await this.persist("tool_result", { callId: call.id, name: kind, ...shown, isError: call.status !== "completed", ...(cancelled ? { cancelled } : call.status === "rejected" && { declined: true }) });
    });
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
      if (allow) { permissionFact("flow", "auto_allowed"); return Promise.resolve(allow.id); }
    }
    const turn = this.ac?.signal ?? signal;
    return this.ask(question, turn, options, toolCallId).then((id) => {
      permissionFact("flow", id ? askOutcome(options, id) : turn.aborted ? "cancelled" : "rejected");
      return id || PERMISSION_CANCELLED;
    });
  }

  private async dropAgent(): Promise<void> {
    const agent = this.agent;
    this.agent = null;
    this.agentModel = "";
    this.agentStartMs = 0;
    try { await agent?.dispose(); } catch { /* it is going away either way */ }
  }

  /** Consent, once, for the life of this machine. A failed write still counts
   *  for this session: the person said yes, and asking again because a file
   *  would not open is worse than forgetting it at the next launch. */
  private async rememberConsent(): Promise<void> {
    this.consented = true;
    emitEvent("onboarding_step", { step: "flow_consent_granted" });
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
