import { liveWsBase } from "./liveClient";
import { reconnectDelay } from "./linkStatus";

// Streaming speech-to-text over the agent's /voice/stream socket: mic frames go
// up while the user talks, partial transcripts come back, and "end" returns the
// utterance's final text about 150 ms later instead of a batch transcription
// that only starts once they stop. Opened the same way as /live (liveClient.ts).

// Finals measured at 120-185 ms when frames arrive in real time; a CPU that falls
// behind real time needs longer. Past this the caller transcribes in batch.
const FINAL_TIMEOUT_MS = 3000;
const MAX_FAILED_OPENS = 4;    // tries without ever reaching "ready" before the engine counts as unavailable

/** `at`: each captionWords(text) word's onset, ms from the utterance's first frame, when the engine times them. */
export type StreamedFinal = { text: string; at?: number[] };

export class AsrStream {
  private ws: WebSocket | null = null;
  private ready = false;
  private closed = false;
  private attempts = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  // One per "end" sent, oldest first: the server answers each with exactly one final.
  private finals: { resolve: (final: StreamedFinal) => void; reject: (e: Error) => void }[] = [];

  constructor(readonly engine: string, readonly lang: string, private h: { onPartial: (text: string) => void; onRefused: (why: string) => void }) {
    this.open();
  }

  /** Frames sent now are transcribed. False while connecting or loading the model. */
  get live() { return this.ready; }

  private open() {
    const tok = (window as { openlive?: { agentToken?: string } }).openlive?.agentToken;
    const ws = new WebSocket(`${liveWsBase()}/voice/stream?engine=${this.engine}&lang=${this.lang}${tok ? `&token=${encodeURIComponent(tok)}` : ""}`);
    ws.binaryType = "arraybuffer";
    let refused = "";
    ws.onmessage = (ev) => {
      let m: { type?: string; text?: string; at?: number[]; error?: string };
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.type === "ready") { this.ready = true; this.attempts = 0; }
      else if (m.type === "partial") this.h.onPartial(m.text ?? "");
      else if (m.type === "final") this.finals.shift()?.resolve({ text: m.text ?? "", at: m.at });
      // The agent says why before closing 1008; the web proxy relays that but
      // closes with its own code, so the message is what marks a refusal. The
      // proxy's own error (agent unreachable) is a failed open, retried below.
      else if (m.type === "error") refused = m.error || "refused";
    };
    ws.onclose = (ev) => {
      this.ready = false;
      for (const f of this.finals.splice(0)) f.reject(new Error("stream closed"));
      if (this.closed) return;
      if (ev.code === 1008 || refused || ++this.attempts >= MAX_FAILED_OPENS) {
        this.closed = true;
        this.h.onRefused(refused || ev.reason || "cannot connect");
        return;
      }
      this.retry = setTimeout(() => { this.retry = null; this.open(); }, reconnectDelay(this.attempts - 1));
    };
    this.ws = ws;
  }

  send(frame: Float32Array) { if (this.ready) this.ws!.send(frame as Float32Array<ArrayBuffer>); }

  /** Drop whatever the server holds, so nothing earlier leaks into the next utterance. */
  reset() { if (this.ready) this.ws!.send(JSON.stringify({ type: "reset" })); }

  /** The utterance is over: its final text. Rejects when the socket is not live,
   *  drops, or the final is late; a late final is then discarded in order. */
  end(): Promise<StreamedFinal> {
    if (!this.ready) return Promise.reject(new Error("stream not live"));
    const p = new Promise<StreamedFinal>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("final timed out")), FINAL_TIMEOUT_MS);
      this.finals.push({ resolve: (t) => { clearTimeout(timer); resolve(t); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    });
    this.ws!.send(JSON.stringify({ type: "end" }));
    return p;
  }

  close() {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    try { this.ws?.close(); } catch { /* already closed */ }
  }
}
