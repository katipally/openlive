import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { SseEvent, MessageBlock, LiveServerMsg } from "@openlive/shared";
import { LIVE_TAG, liveClientMsgSchema } from "@openlive/shared";
import { createChat, addMessage, listMessages } from "@openlive/db";
import type { Message } from "@openlive/harness";
import type { Emit, TaktTool } from "../tools.js";
import { foldBlock } from "../block-emit.js";
import { LiveTurnRunner } from "./turn-runner.js";

type Frame = { data: string; mime: string };
const HISTORY_TURNS = 20; // recent messages to rehydrate on reconnect

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
  private ac: AbortController | null = null;
  private turnActive = false;
  private queuedText: string | null = null; // an utterance that arrived mid-turn (barge-in)
  private bargeSpoken: string | null = null; // on barge-in, the text the client actually SPOKE
  private cameraOn = false;
  private lastFrame: Frame | null = null; // freshest camera frame, attached per turn
  private closed = false;

  // `look` tool ↔ client hi-res frame handshake.
  private lookPending: { reqId: string; resolve: (f: Frame | null) => void } | null = null;
  private awaitingLookFrame = false;

  constructor(private ws: WebSocket, private chatId: string) {
    const lookTool: TaktTool = {
      name: "look",
      description: "Capture a fresh, higher-resolution frame from the user's camera and see it right now. Use when you need a closer or more current look at what the user is showing you. If the camera is off this returns nothing — then ask the user to turn it on.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        if (!this.cameraOn) return { output: "The camera is off, so I can't see anything right now. Ask the user to turn on their camera." };
        const frame = await this.requestFrame();
        if (!frame) return { output: "Couldn't grab a camera frame (it timed out). Ask the user to check their camera." };
        return { output: "This is what the user's camera is showing right now — talk about it naturally, as what you're both looking at.", images: [frame] };
      },
    };
    this.runner = new LiveTurnRunner([lookTool]);

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
      case "user_text": return void this.runTurn(msg.text);
      case "cancel": if (this.turnActive) this.bargeSpoken = msg.spoken ?? null; return this.interrupt();
      case "control":
        if (msg.action === "camera_on") this.cameraOn = true;
        else if (msg.action === "camera_off") { this.cameraOn = false; this.lastFrame = null; }
        else if (msg.action === "end") this.dispose();
        return;
      case "frame_response":
        if (this.lookPending?.reqId === msg.reqId) this.awaitingLookFrame = true;
        return;
    }
  }

  // ── turn ────────────────────────────────────────────────────────────────
  private async runTurn(text: string) {
    if (!text.trim() || this.closed) return;
    // A new utterance during an in-flight turn (barge-in) must NOT be dropped:
    // queue it (append) and the finally below drains it as one turn.
    if (this.turnActive) { this.queuedText = this.queuedText ? `${this.queuedText} ${text}` : text; return; }
    this.turnActive = true;
    const ac = new AbortController();
    this.ac = ac;
    const frames = this.cameraOn && this.lastFrame ? [this.lastFrame] : [];

    const blocks: MessageBlock[] = [];
    const emit = this.blockEmit(blocks, ac.signal);

    if (this.chatId) addMessage(this.chatId, "user", [{ type: "text", text }], true /* live */);
    try {
      await this.runner.runTurn(text, frames, emit, ac.signal);
    } catch (e) {
      if (!ac.signal.aborted) console.error("[live] turn:", e);
    } finally {
      // On barge-in, persist only what was actually SPOKEN.
      if (ac.signal.aborted && this.bargeSpoken != null) truncateSpokenText(blocks, this.bargeSpoken);
      this.bargeSpoken = null;
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

  private interrupt() { this.ac?.abort(); }

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
    this.ac?.abort();
    this.lookPending?.resolve(null);
    try { this.ws.close(); } catch { /* already closing */ }
  }
}
