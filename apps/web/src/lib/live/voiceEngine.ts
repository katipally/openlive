import { MicVAD } from "@ricky0123/vad-web";
import { AudioPlayer } from "./audioPlayback";
import { stt, tts, hasWebGPU, turnComplete, turnModelReady } from "./models";
import { isJunk, endsMidThought, stripMarkdown, SentenceChunker } from "./voiceText";
import { perf } from "./perf";

// The on-device conversation loop (replaces the old server pipeline). Silero VAD
// segments the user's speech; Whisper transcribes it (streaming partials + a
// final); a light "mid-thought" check holds through natural pauses; the final
// text goes to the server; the LLM's reply text streams back and is spoken with
// Kokoro. Barge-in is a LOCAL decision, no server round-trip for audio.
export type EnginePhase = "idle" | "listening" | "thinking" | "speaking";

export interface VoiceEngineHandlers {
  onPhase: (p: EnginePhase) => void;
  onPartial: (text: string) => void;      // interim user caption (greyed)
  onUserText: (text: string) => void;      // final user turn → send to server
  onAgentText: (sentence: string, durationMs: number) => void; // agent caption chunk + how long it plays (for word-timed reveal)
  onBargeIn: (spoken: string) => void;      // cancel the LLM stream; `spoken` = what was actually voiced so far
}

const PARTIAL_MS = 500;      // min gap between interim transcriptions
const HOLD_MS = 4000;        // safety: never hold a mid-thought pause longer than this
const ONSET_GRACE_MS = 250;  // agent's own first syllable can't self-trigger barge-in
const MIN_UTTER_SAMPLES = 16000 * 0.25; // ignore <0.25s blips
const RMS_GATE = 0.006;      // reject near-silence; low enough to hear a soft talker

function rmsOf(a: Float32Array): number { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * a[i]!; return Math.sqrt(s / a.length); }

export class VoiceEngine {
  private vad: MicVAD | null = null;
  private player: AudioPlayer;
  private chunker = new SentenceChunker();
  private phase: EnginePhase = "idle";

  private pending: Float32Array | null = null;   // held mid-thought utterance
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private curBuf: Float32Array[] = [];           // frames since speech start (for partials)
  private curLen = 0;
  private lastPartialAt = 0;
  private partialBusy = false;
  private finalizing = false;

  private micRms = 0;
  private noiseFloor = 0.002;                     // learned room ambient (see onFrame/gate)
  private epoch = 0;                              // bumped on barge-in; stales TTS + audio
  private ttsChain: Promise<void> = Promise.resolve();
  private speakingStartAt = 0;
  private turnSentAt = 0;                         // perf: when the final user text went out
  private spokenText = "";                         // what the agent has actually VOICED this reply (for barge-in cutoff)

  // Accept a pre-primed player so audio can be unlocked DURING the Start click
  // (iOS blocks audio started after an await — see useLiveSession.start).
  constructor(private h: VoiceEngineHandlers, player?: AudioPlayer) { this.player = player ?? new AudioPlayer(); }

  async start(stream: MediaStream) {
    this.player.resume();
    this.vad = await MicVAD.new({
      model: "v5",
      // Serve the Silero worklet + onnx + ort wasm from a CDN (the default
      // resolves them to the app origin, which 404s). ponytail: CDN keeps it
      // zero-config; vendor these into /public for a fully-offline HF Space.
      baseAssetPath: "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.29/dist/",
      onnxWASMBasePath: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/",
      getStream: async () => stream,             // our stream: chosen device + AEC on
      positiveSpeechThreshold: 0.5,              // lower → picks up soft speech + faster barge-in
      negativeSpeechThreshold: 0.35,
      minSpeechMs: 250,
      // Wait through short natural pauses before ending a turn. Kept modest because
      // Smart-Turn v3 (semantic end-of-turn) + the mid-thought hold below already
      // catch premature ends — so we don't need a long silence buffer, and shaving it
      // takes real latency off every turn. ponytail: raise toward 700 if it starts
      // cutting slow talkers off mid-sentence.
      redemptionMs: 550,
      onSpeechStart: () => this.onSpeechStart(),
      onSpeechEnd: (audio) => { void this.onSpeechEnd(audio); },
      onFrameProcessed: (_p, frame) => this.onFrame(frame),
      onVADMisfire: () => { if (this.phase === "listening") this.setPhase("idle"); },
    });
    await this.vad.start();
    this.setPhase("idle");
  }

  /** Swap the mic mid-call (device change) — rebuild the VAD on the new stream
   *  without touching the audio player, so a reply in progress keeps playing. */
  async setStream(stream: MediaStream) {
    this.clearHold();
    this.pending = null;
    try { this.vad?.destroy(); } catch { /* */ }
    this.vad = null;
    await this.start(stream);
  }

  // ── user speech ─────────────────────────────────────────────────────────
  private onSpeechStart() {
    // Barge-in: user talks over the agent (past the onset grace) → kill audio now.
    if ((this.phase === "speaking" || this.player.level() > 0) && Date.now() - this.speakingStartAt > ONSET_GRACE_MS) {
      this.bargeIn();
    }
    this.clearHold();
    this.curBuf = []; this.curLen = 0;
    this.setPhase("listening");
  }

  private onFrame(frame: Float32Array) {
    // Mic level for the orb (smoothed RMS).
    let sum = 0; for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
    const rms = Math.sqrt(sum / frame.length);
    this.micRms += (rms - this.micRms) * 0.3;
    // Learn the room's ambient noise floor WHILE IDLE (never during the user's own
    // speech), so the reject-gate rises in a loud room / around a TV and stops
    // background chatter tripping a turn — but stays at the fixed floor in a quiet
    // room so a soft talker is still heard. ponytail: a real room needs this
    // calibration; clamp keeps it from ever rising high enough to swallow speech.
    if (this.phase === "idle") this.noiseFloor = Math.min(0.03, this.noiseFloor + (rms - this.noiseFloor) * 0.05);
    if (this.phase !== "listening") return;
    this.curBuf.push(frame); this.curLen += frame.length;
    void this.maybePartial();
  }

  // Reject threshold: the fixed floor, or a margin above the learned room noise
  // (whichever is higher), capped so it can't rise enough to reject real speech.
  private gate(): number { return Math.min(0.03, Math.max(RMS_GATE, this.noiseFloor * 1.6)); }

  // Interim caption while speaking (WebGPU only — too slow to be useful on WASM).
  private async maybePartial() {
    if (!hasWebGPU() || this.partialBusy || this.finalizing) return;
    const now = Date.now();
    if (now - this.lastPartialAt < PARTIAL_MS || this.curLen < MIN_UTTER_SAMPLES) return;
    this.lastPartialAt = now;
    this.partialBusy = true;
    try {
      const win = this.concat(this.curBuf, this.curLen);
      if (rmsOf(win) < this.gate()) return;
      const text = await stt(win);
      if (text && !isJunk(text) && this.phase === "listening") this.h.onPartial(text);
    } catch { /* best-effort */ }
    finally { this.partialBusy = false; }
  }

  private async onSpeechEnd(audio: Float32Array) {
    if (this.finalizing) return;
    const combined = this.pending ? this.concat([this.pending, audio], this.pending.length + audio.length) : audio;
    // Reject blips and near-silence up front (ambient noise that tripped the VAD).
    if (combined.length < MIN_UTTER_SAMPLES || rmsOf(audio) < this.gate()) { this.pending = null; if (this.phase === "listening") this.setPhase("idle"); return; }
    this.finalizing = true;
    const perf0 = performance.now();
    try {
      // Transcribe AND ask Smart-Turn (semantic end-of-turn) in parallel. If the
      // turn model isn't loaded, fall back to the VAD's silence endpointing.
      const [text, modelComplete] = await Promise.all([
        stt(combined).then((t) => t.trim()),
        turnModelReady() ? turnComplete(combined) : Promise.resolve(true),
      ]);
      const sttEndpointMs = performance.now() - perf0;
      console.debug(`[live:perf] transcribe+turn ${Math.round(sttEndpointMs)}ms`);
      // Drop empties and Whisper's silence-hallucinations so background noise and
      // dead air never fire a turn.
      if (isJunk(text)) { this.pending = null; this.setPhase("idle"); return; }
      // Hold through a mid-thought pause (model says "not done", or the words
      // trail off) instead of cutting in — but never longer than HOLD_MS / 20 s.
      const done = modelComplete && !endsMidThought(text);
      if (!done && combined.length < 16000 * 20) {
        this.pending = combined;
        this.h.onPartial(text);
        this.scheduleHold();
        this.setPhase("idle");
        return;
      }
      this.pending = null;
      this.clearHold();
      this.setPhase("thinking");
      this.spokenText = ""; // new turn: clear the previous reply's spoken text
      this.turnSentAt = performance.now();
      perf.turnCommitted(sttEndpointMs);
      this.h.onUserText(text);
    } catch {
      this.pending = null; this.setPhase("idle");
    } finally { this.finalizing = false; }
  }

  private scheduleHold() {
    this.clearHold();
    this.holdTimer = setTimeout(() => {
      const p = this.pending; this.pending = null; this.holdTimer = null;
      if (p && this.phase === "idle") { void stt(p).then((t) => { const text = t.trim(); if (text) { this.setPhase("thinking"); this.spokenText = ""; this.turnSentAt = performance.now(); this.h.onUserText(text); } }); }
    }, HOLD_MS);
  }
  private clearHold() { if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; } }

  // ── agent reply → speech ───────────────────────────────────────────────
  feedAgentDelta(text: string) {
    perf.firstToken(); // no-op after the first delta of a turn
    for (const s of this.chunker.push(text)) this.enqueueSpeak(s, this.epoch);
  }
  endAgentTurn() {
    const tail = this.chunker.flush();
    if (tail) this.enqueueSpeak(tail, this.epoch);
    // When the TTS chain drains and audio finishes, drop back to idle.
    const ep = this.epoch;
    void this.ttsChain.then(() => { if (this.epoch === ep && this.phase === "speaking") this.waitDrainThenIdle(ep); if (this.epoch === ep && this.phase === "thinking") this.setPhase("idle"); });
  }
  private waitDrainThenIdle(ep: number) {
    const check = () => {
      if (this.epoch !== ep) return;
      if (this.player.level() > 0) { setTimeout(check, 120); return; }
      if (this.phase === "speaking") this.setPhase("idle");
    };
    check();
  }

  private enqueueSpeak(sentence: string, epoch: number) {
    this.ttsChain = this.ttsChain.then(async () => {
      if (this.epoch !== epoch) return; // barged-in → drop stale speech
      const spoken = stripMarkdown(sentence);
      if (!spoken) return;
      const { audio, sampleRate } = await tts(spoken);
      if (this.epoch !== epoch) return;
      const durationMs = (audio.length / sampleRate) * 1000; // how long THIS chunk voices — paces the caption reveal
      if (this.phase !== "speaking") {
        this.speakingStartAt = Date.now(); this.setPhase("speaking");
        if (this.turnSentAt) { console.debug(`[live:perf] first audio ${Math.round(performance.now() - this.turnSentAt)}ms after user done`); this.turnSentAt = 0; perf.firstAudio(); }
      }
      // Show the caption for THIS chunk when it actually starts playing (not now,
      // when it finished synthesizing — synth runs ahead of the voice), so the
      // subtitle reads out only the words being spoken right now.
      this.player.play(audio, epoch, sampleRate, () => {
        if (this.epoch !== epoch) return;
        // Accumulate ONLY as each chunk actually begins playing — so on barge-in
        // `spokenText` is exactly what was voiced, and the unspoken (still-queued)
        // tail is excluded from the saved history.
        this.spokenText += (this.spokenText ? " " : "") + spoken;
        this.h.onAgentText(spoken, durationMs);
      });
    }).catch((e) => { console.warn("[live] TTS failed:", e?.message ?? e); });
  }

  private bargeIn() {
    this.epoch++;
    this.player.flush(this.epoch);
    this.chunker.flush();
    this.h.onBargeIn(this.spokenText.trim());
  }

  // ── helpers / lifecycle ────────────────────────────────────────────────
  private concat(parts: Float32Array[], total: number): Float32Array {
    const out = new Float32Array(total); let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }
  private setPhase(p: EnginePhase) { if (p !== this.phase) { this.phase = p; this.h.onPhase(p); } }

  /** Mute (push-to-talk / manual): pause listening; a held pending is dropped. */
  setMuted(muted: boolean) {
    if (!this.vad) return;
    if (muted) { this.clearHold(); this.pending = null; this.micRms = 0; void this.vad.pause(); if (this.phase === "listening") this.setPhase("idle"); }
    else void this.vad.start();
  }

  micLevel() { return this.micRms; }
  agentLevel() { return this.player.level(); }
  speechProgress() { return this.player.progress(); }

  stop() {
    this.clearHold();
    this.epoch++;
    try { this.vad?.destroy(); } catch { /* */ }
    this.vad = null;
    this.player.close();
  }
}
