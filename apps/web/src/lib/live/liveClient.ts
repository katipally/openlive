import type { SseEvent, AgentIdWire, AgentMetaWire } from "@openlive/shared";

// Browser side of the /live WebSocket. Same-origin (the web server proxies it to
// the agent). THIN protocol: we send final user text + camera frames + a cancel
// signal, and receive the LLM's reply as chat SSE events. No audio on the wire —
// the browser runs the voice models on-device.
const TAG_FRAME_IN = 0x02;

export type AgentId = AgentIdWire;
export type AgentMeta = AgentMetaWire;
// `kind` is the ACP option kind (allow_once/allow_always/reject_once/reject_always)
// when the ask comes from a coding agent — drives styling + voice yes/no mapping.
export type PermissionOption = { id: string; label: string; kind?: string };
export type ElicitationWire = { reqId: string; mode: "url" | "form"; message: string; url?: string; schema?: unknown; expiresAt?: number };

export interface LiveHandlers {
  onOpen?: () => void;
  onClose?: () => void;
  onReconnecting?: () => void;
  onSse?: (e: SseEvent) => void;
  onNeedFrame?: (reqId: string) => void;
  onToolBridge?: (reqId: string, op: "clipboard_read" | "clipboard_write" | "open_url", arg?: string) => void;
  onPermission?: (reqId: string, question: string, options: PermissionOption[], expiresAt?: number, toolCallId?: string) => void;
  onPermissionResolved?: (reqId: string) => void;
  onElicitation?: (e: ElicitationWire) => void;
  onElicitationResolved?: (reqId: string) => void;
  onAgentMeta?: (meta: AgentMeta) => void;
  onReloadHistory?: () => void;
  /** Authoritative bind echo: what agent + folder the server session is ACTUALLY
   *  using, and whether the coding agent is running. */
  onBoundState?: (agentId: AgentId | null, cwd: string, agentActive: boolean) => void;
  onError?: (message: string) => void;
}

export class LiveClient {
  private ws: WebSocket | null = null;
  private chatId = "";
  private closedByUser = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private healthyTimer: ReturnType<typeof setTimeout> | null = null;
  private static MAX_RECONNECT = 4;
  private static HEALTHY_MS = 3000; // a connection must survive this long to "count"
  private static MAX_QUEUE = 8;     // cap queued turns during an outage (drop oldest)
  private queue: string[] = [];     // user turns spoken while the socket was down, flushed on reopen
  constructor(private h: LiveHandlers) {}

  connect(chatId: string) {
    this.chatId = chatId;
    this.closedByUser = false;
    this.open();
  }

  private open() {
    const base = process.env.NEXT_PUBLIC_LIVE_WS_URL
      || `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
    // Desktop connects straight to the agent (no proxy to inject the auth header),
    // so the per-launch token rides as a query param. Empty everywhere else.
    const tok = (window as { openlive?: { agentToken?: string } }).openlive?.agentToken;
    const auth = tok ? `&token=${encodeURIComponent(tok)}` : "";
    const ws = new WebSocket(`${base}/live?chat=${encodeURIComponent(this.chatId)}${auth}`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.h.onOpen?.(); // sends the bind FIRST so a flushed turn lands on a bound agent
      // Flush any user turns that were spoken during the reconnect window — otherwise
      // the turn is silently lost (the UI shows a bubble + "Thinking…" that never
      // resolves). Order preserved; frames rode along inline in each queued message.
      if (this.queue.length && ws.readyState === WebSocket.OPEN) {
        for (const s of this.queue.splice(0)) ws.send(s);
      }
      // Do NOT zero `attempts` here: on the container path the socket can open and
      // then instantly flap closed, and resetting on every open made "Reconnecting…"
      // loop forever. Only a connection that SURVIVES counts as recovered.
      this.healthyTimer = setTimeout(() => { this.attempts = 0; }, LiveClient.HEALTHY_MS);
    };
    ws.onclose = (ev) => {
      if (this.healthyTimer) { clearTimeout(this.healthyTimer); this.healthyTimer = null; }
      if (this.closedByUser) { this.h.onClose?.(); return; }
      // Unexpected drop → reconnect a few times. The server rehydrates the
      // conversation from the DB, so the agent keeps its context across the drop.
      if (this.attempts < LiveClient.MAX_RECONNECT) {
        this.h.onReconnecting?.();
        const delay = Math.min(2000, 300 * 2 ** this.attempts++);
        this.reconnectTimer = setTimeout(() => this.open(), delay);
      } else {
        // The server closes with a reason (e.g. "agent HTTP 401") — surface it so
        // the user learns why instead of staring at an endless spinner.
        const why = ev?.reason?.trim();
        this.h.onError?.(why ? `Live disconnected: ${why}` : "Couldn't connect to live mode. Please try again.");
        this.h.onClose?.();
      }
    };
    ws.onerror = () => { /* onclose follows; reconnect handles it */ };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return; // server sends no binary now
      this.attempts = 0; // a real message proves the whole path works → reset budget
      let m: any;
      try { m = JSON.parse(ev.data); } catch { return; }
      switch (m.t) {
        case "sse": return this.h.onSse?.(m.event);
        case "need_frame": return this.h.onNeedFrame?.(m.reqId);
        case "tool_bridge": return this.h.onToolBridge?.(m.reqId, m.op, m.arg);
        case "permission": return this.h.onPermission?.(m.reqId, m.question, m.options, m.expiresAt, m.toolCallId);
        case "permission_resolved": return this.h.onPermissionResolved?.(m.reqId);
        case "elicitation": return this.h.onElicitation?.(m);
        case "elicitation_resolved": return this.h.onElicitationResolved?.(m.reqId);
        case "agent_meta": return this.h.onAgentMeta?.(m);
        case "bound_state": return this.h.onBoundState?.(m.agentId, m.cwd, m.agentActive);
        case "reload_history": return this.h.onReloadHistory?.();
        case "error": return this.h.onError?.(m.message);
      }
    };
    this.ws = ws;
  }

  private sendJson(m: unknown) { if (this.ready) this.ws!.send(JSON.stringify(m)); }
  /** A user turn is too important to drop: if the socket is mid-reconnect, queue it
   *  and flush on reopen. Other messages (frames, control, cancel) are ephemeral. */
  private sendUserTurn(m: unknown) {
    const s = JSON.stringify(m);
    if (this.ready) { this.ws!.send(s); return; }
    if (this.closedByUser) return; // session over — don't hold onto it
    this.queue.push(s);
    if (this.queue.length > LiveClient.MAX_QUEUE) this.queue.shift();
  }
  userText(text: string, frames?: { data: string; mime: string; source: "camera" | "screen" }[]) {
    this.sendUserTurn({ t: "user_text", text, ...(frames && frames.length ? { frames } : {}) });
  }
  cancel(spoken?: string) { this.sendJson({ t: "cancel", ...(spoken ? { spoken } : {}) }); }
  control(action: "camera_on" | "camera_off" | "screen_on" | "screen_off" | "end") { this.sendJson({ t: "control", action }); }
  frameResponse(reqId: string) { this.sendJson({ t: "frame_response", reqId }); }
  toolBridgeResult(reqId: string, output: string) { this.sendJson({ t: "tool_bridge_result", reqId, output }); }
  /** Bind this conversation to a coding agent (null = provider brain) + project folder.
   *  cwd ALWAYS travels (empty string = no folder) — the old omit-when-empty shape let
   *  a transiently-empty store silently strand the server on a stale/absent folder. */
  bind(agentId: AgentId | null, cwd: string, resumeSessionId?: string) { this.sendJson({ t: "bind", agentId, cwd, ...(resumeSessionId ? { resumeSessionId } : {}) }); }
  /** Answer an agent permission ask (chip tap or spoken yes/no). */
  permissionResponse(reqId: string, optionId: string) { this.sendJson({ t: "permission_response", reqId, optionId }); }
  /** Answer an agent elicitation (form submit / spoken "done" / cancel). */
  elicitationResponse(reqId: string, action: "accept" | "decline" | "cancel", content?: Record<string, unknown>) {
    this.sendJson({ t: "elicitation_response", reqId, action, ...(content ? { content } : {}) });
  }
  /** Switch the bound agent's model / mode mid-session. */
  setModel(modelId: string) { this.sendJson({ t: "set_model", modelId }); }
  setMode(modeId: string) { this.sendJson({ t: "set_mode", modeId }); }
  setOption(optionId: string, valueId: string) { this.sendJson({ t: "set_option", optionId, valueId }); }

  sendFrame(jpeg: ArrayBuffer) {
    if (!this.ready) return;
    const out = new Uint8Array(jpeg.byteLength + 1);
    out[0] = TAG_FRAME_IN;
    out.set(new Uint8Array(jpeg), 1);
    this.ws!.send(out.buffer);
  }

  get ready() { return this.ws?.readyState === WebSocket.OPEN; }
  close() {
    this.closedByUser = true;
    this.queue.length = 0;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.healthyTimer) { clearTimeout(this.healthyTimer); this.healthyTimer = null; }
    this.control("end");
    try { this.ws?.close(); } catch { /* */ }
    this.ws = null;
  }
}
