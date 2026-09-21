import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { LiveServerMsg } from "@openlive/shared";
import { flowContextSchema, liveClientMsgSchema } from "@openlive/shared";
import { FlowSession as FlowStoreSession, readFlowConfig, type FlowConfig } from "@openlive/flow-store";
import { AcpBrain, LocalBrain } from "../flow/brain.js";
import { serveFlowMcp } from "../flow/mcp.js";
import { AcpAgent } from "../agents/acp-agent.js";
import { AgentSupervisor } from "../agents/supervisor.js";
import { agentCwd, PERMISSION_CANCELLED, type Agent, type PermissionAskOption } from "../agents/index.js";
import type { McpServerWire } from "../agents/mcp-config.js";
import { isAgentId } from "@openlive/shared";
import { runFlow } from "../flow/loop.js";
import { buildFlowPrompt } from "../flow/prompt.js";
import { voiceApprove } from "../flow/approval.js";
import { ForwardOnlyInsertion, flowTools } from "../flow/tools.js";
import type { DevicePort } from "../flow/device.js";
import type { Approve, Brain, ClipboardPort, ContextProvider, FlowContext, Msg } from "../flow/types.js";
import { log } from "../log.js";

// Flow's half of the /live socket. It is a SEPARATE connection from chat's: the
// pill runtime lives in its own renderer, and a WebSocket cannot be shared across
// renderers. But it is the same endpoint, the same schemas and the same
// permission protocol, so nothing about LiveSession changes.

const BRIDGE_TIMEOUT_MS = 8_000;
/** Perception is slower than the clipboard: OCR pays a one-off Vision warm-up of about 26 seconds per process. */
const DEVICE_TIMEOUT_MS = 40_000;
const ASK_TIMEOUT_MS = 20_000;
/** Enough of a turn to stay useful without turning the session file into a corpus. */
const PERSIST_TEXT_CAP = 20_000;

/** Cut a persisted reply back to what the voice actually said before the user cut in. */
export function truncateToSpoken(messages: Msg[], spoken: string): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    m.text = spoken.trim() || undefined;
    if (!m.text && !m.toolCalls?.length) messages.splice(i, 1);
    return;
  }
}

const safeJson = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } };

const YES_NO: PermissionAskOption[] = [
  { id: "allow", label: "Yes", kind: "allow_once" },
  { id: "deny", label: "Cancel", kind: "reject_once" },
];

export class FlowLiveSession {
  private closed = false;
  private ac: AbortController | null = null;
  private turnActive = false;
  private spoken: string | null = null;
  /** Utterances that arrived mid-run: the loop drains them between turns. */
  private steering: Msg[] = [];
  private messages: Msg[] = [];
  private brain: Brain = new LocalBrain();
  /** The coding-agent brain and the MCP server publishing Flow's tools to it. */
  private agent: Agent | null = null;
  private mcp: { wire: McpServerWire; close(): Promise<void> } | null = null;
  /** Rebuilt every turn from the user's current tiers, and read by both brains. */
  private approve: Approve = async () => ({});
  private bridgePending = new Map<string, (out: string) => void>();
  private permPending = new Map<string, (optionId: string) => void>();
  private store: FlowStoreSession | null = null;
  private opening: Promise<FlowStoreSession> | null = null;
  /** The metadata the desktop captured as the user spoke, used until a fresher read lands. */
  private lastContext: FlowContext | null = null;

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
        // An ask is awaiting the user, so this utterance is its ANSWER, never a new
        // turn. The client routes it when its chip is up; a raced one lands here and
        // is bounced back instead of leaking to the model as a fresh prompt.
        if (this.permPending.size) { this.send({ t: "modal_voice_answer", text: msg.text }); return; }
        if (msg.context) this.lastContext = msg.context;
        return this.onUtterance(msg.text);
      }
      case "flow_cancel":
        // While an ask is open the "barge-in" IS the user answering it.
        if (this.permPending.size) return;
        if (this.turnActive) this.spoken = msg.spoken ?? "";
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
    void this.persist("message", { role: "user", text });
    if (this.turnActive) { this.steering.push(m); return; }
    this.messages.push(m);
    void this.run();
  }

  // ── the turn ──────────────────────────────────────────────────────────────

  private async run() {
    this.turnActive = true;
    const ac = new AbortController();
    this.ac = ac;
    const cfg = readFlowConfig();
    this.approve = voiceApprove({
      tiers: cfg.risk,
      perTool: cfg.toolRisk,
      timeoutMs: ASK_TIMEOUT_MS,
      ask: (question, signal) => this.askPermission(question, signal),
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
        getSystemPrompt: () => buildFlowPrompt({ tools: this.tools }),
        pollSteering: () => this.steering.splice(0),
      })) {
        this.send({ t: "flow", event });
        void this.record(event);
      }
    } catch (e) {
      log.error("flow", "turn:", e);
      this.send({ t: "flow", event: { type: "error", message: "That turn failed.", aborted: false } });
      this.send({ t: "flow", event: { type: "done", reason: "error" } });
    } finally {
      this.turnActive = false;
      this.ac = null;
      // An ask left hanging by a cancelled turn must be settled, or the client's
      // chip stays up and swallows the user's next sentence as a yes/no.
      this.cancelPendingPermissions();
      if (ac.signal.aborted && this.spoken !== null) truncateToSpoken(this.messages, this.spoken);
      this.spoken = null;
      const last = this.messages[this.messages.length - 1];
      if (last?.role === "assistant" && (last.text || last.toolCalls?.length)) {
        void this.persist("message", { role: "assistant", text: last.text?.slice(0, PERSIST_TEXT_CAP) ?? "" });
      }
      if (this.steering.length && !this.closed) {
        this.messages.push(...this.steering.splice(0));
        void this.run();
      }
    }
  }

  /** The session file mirrors the turn; the transcript in memory is the model's copy. */
  private record(event: { type: string } & Record<string, unknown>): Promise<unknown> | void {
    if (event.type === "context") return this.persist("context", { context: event.context });
    if (event.type === "tool_call") return this.persist("tool_call", { callId: event.id, name: event.name, args: event.args });
    if (event.type === "tool_result") return this.persist("tool_result", { callId: event.id, name: event.name, isError: event.isError });
  }

  private async persist(type: "message" | "context" | "tool_call" | "tool_result", data: Record<string, unknown>): Promise<void> {
    try { await (await this.session()).append(type, data); }
    catch (e) { log.error("flow", "persist:", e); }
  }

  /** One rolling session. On idle expiry it archives itself and the next utterance
   *  opens a fresh one with a fresh transcript. */
  private session(): Promise<FlowStoreSession> {
    if (this.store) return Promise.resolve(this.store);
    if (!this.opening) {
      this.opening = FlowStoreSession.open({
        idleMs: readFlowConfig().idleWindowMs,
        meta: { mode: "flow" },
        onIdle: () => { this.store = null; this.opening = null; this.messages = []; },
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
      this.send({ t: "tool_bridge", reqId, op, arg });
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
    if (this.agent && this.brain.id === agentId) return this.brain;
    void this.dropAgent();
    this.mcp ??= await serveFlowMcp({
      tools: this.tools,
      ctx: () => ({ signal: this.ac?.signal ?? signal, context: this.lastContext, insert: this.insert, clipboard: this.clipboard }),
      approve: (req, s) => this.approve(req, s),
    });
    const wire = this.mcp.wire;
    const agent = new AgentSupervisor(
      (ask) => new AcpAgent(agentId, ask, { cwd: agentCwd("flow"), mcpServers: [wire] }),
      (question, options, toolCallId) => this.ask(question, this.ac?.signal ?? signal, options, toolCallId).then((id) => id || PERMISSION_CANCELLED),
      { startMs: 60_000 },
    );
    await agent.start(signal);
    this.agent = agent;
    return (this.brain = new AcpBrain(agent));
  }

  private async dropAgent(): Promise<void> {
    const agent = this.agent;
    this.agent = null;
    try { await agent?.dispose(); } catch { /* it is going away either way */ }
  }

  /** The same permission protocol chat uses: chips on the pill, spoken yes/no. */
  private askPermission(question: string, signal: AbortSignal): Promise<boolean> {
    return this.ask(question, signal, YES_NO).then((id) => id === "allow");
  }

  /** Resolves the option the user picked, or "" when they refused, ran out of time or cut in. */
  private ask(question: string, signal: AbortSignal, options: PermissionAskOption[], toolCallId?: string): Promise<string> {
    return new Promise((resolve) => {
      if (this.closed || signal.aborted) return resolve("");
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
      this.send({ t: "permission", reqId, question, options, expiresAt: Date.now() + ASK_TIMEOUT_MS, ...(toolCallId ? { toolCallId } : {}) });
    });
  }

  private async deviceCall<T>(fn: string, args?: unknown): Promise<T> {
    const raw = await this.bridge("flow_device", JSON.stringify({ fn, args }), DEVICE_TIMEOUT_MS);
    const reply = safeJson(raw) as { value?: T; error?: string } | null;
    if (!reply) throw new Error(`The machine did not answer in time (${fn}).`);
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
