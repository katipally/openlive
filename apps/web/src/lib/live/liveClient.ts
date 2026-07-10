import type { SseEvent } from "@openlive/shared";

// Browser side of the /live WebSocket. Same-origin (the web server proxies it to
// the agent). THIN protocol: we send final user text + camera frames + a cancel
// signal, and receive the LLM's reply as chat SSE events. No audio on the wire —
// the browser runs the voice models on-device.
const TAG_FRAME_IN = 0x02;

export interface LiveHandlers {
  onOpen?: () => void;
  onClose?: () => void;
  onReconnecting?: () => void;
  onSse?: (e: SseEvent) => void;
  onNeedFrame?: (reqId: string) => void;
  onToolBridge?: (reqId: string, op: "clipboard_read" | "clipboard_write" | "open_url", arg?: string) => void;
  onError?: (message: string) => void;
}

export class LiveClient {
  private ws: WebSocket | null = null;
  private slug = "";
  private chatId = "";
  private closedByUser = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private healthyTimer: ReturnType<typeof setTimeout> | null = null;
  private static MAX_RECONNECT = 4;
  private static HEALTHY_MS = 3000; // a connection must survive this long to "count"
  constructor(private h: LiveHandlers) {}

  connect(productSlug: string | null, chatId: string) {
    // null slug = master mode → the server maps "master" to a no-product session.
    this.slug = productSlug ?? "master"; this.chatId = chatId;
    this.closedByUser = false;
    this.open();
  }

  private open() {
    const base = process.env.NEXT_PUBLIC_LIVE_WS_URL
      || `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
    const ws = new WebSocket(`${base}/live?product=${encodeURIComponent(this.slug)}&chat=${encodeURIComponent(this.chatId)}`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.h.onOpen?.();
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
        case "error": return this.h.onError?.(m.message);
      }
    };
    this.ws = ws;
  }

  private sendJson(m: unknown) { if (this.ready) this.ws!.send(JSON.stringify(m)); }
  userText(text: string, frames?: { data: string; mime: string; source: "camera" | "screen" }[]) {
    this.sendJson({ t: "user_text", text, ...(frames && frames.length ? { frames } : {}) });
  }
  cancel(spoken?: string) { this.sendJson({ t: "cancel", ...(spoken ? { spoken } : {}) }); }
  control(action: "camera_on" | "camera_off" | "screen_on" | "screen_off" | "end") { this.sendJson({ t: "control", action }); }
  frameResponse(reqId: string) { this.sendJson({ t: "frame_response", reqId }); }
  toolBridgeResult(reqId: string, output: string) { this.sendJson({ t: "tool_bridge_result", reqId, output }); }

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
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.healthyTimer) { clearTimeout(this.healthyTimer); this.healthyTimer = null; }
    this.control("end");
    try { this.ws?.close(); } catch { /* */ }
    this.ws = null;
  }
}
