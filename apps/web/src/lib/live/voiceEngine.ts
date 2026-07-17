import { MicVAD } from "@ricky0123/vad-web";
import { AudioPlayer } from "./audioPlayback";
import { stt, tts, hasWebGPU, turnComplete, turnModelReady } from "./models";
import { isJunk, endsMidThought, stripMarkdown, SentenceChunker } from "./voiceText";
import { octaveBands } from "./spectrum";
import { perf } from "./perf";
import { loadPipelineConfig } from "./pipelineConfig";
import { log } from "@/lib/log";

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
  // A mid-thought pause is being held: `until` = when it auto-sends (UI shows a
  // "waiting for you… tap to send" affordance); null = hold resolved/cancelled.
  onHold: (h: { until: number } | null) => void;
  /** True while user speech must NOT barge in — e.g. a permission ask is pending
   *  and the next utterance IS the answer. Cancelling there killed the very ask
   *  the user was answering (the chip vanished the moment they spoke). */
  holdBargeIn?: () => boolean;
}

const PARTIAL_MS = 500;      // min gap between interim transcriptions
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
  private ptt = false;                            // push-to-talk held: accumulate until release, no auto-send
  private muted = false;                          // mirrors setMuted — PTT temporarily lifts a mute, then restores it

  private micRms = 0;
  // A dedicated analyser on the mic stream → a real frequency spectrum for the orb
  // while YOU talk (the VAD's frames only give amplitude, not per-band energy).
  private specCtx: AudioContext | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private micFreq: Uint8Array | null = null;
  private micSrc: MediaStreamAudioSourceNode | null = null;
  private noiseFloor = 0.002;                     // learned room ambient (see onFrame/gate)
  private epoch = 0;                              // bumped on barge-in; stales TTS + audio
  private ttsChain: Promise<void> = Promise.resolve();
  private speakingStartAt = 0;
  private turnSentAt = 0;                         // perf: when the final user text went out
  private spokenText = "";                         // what the agent has actually VOICED this reply (for barge-in cutoff)
  // After a barge-in, IGNORE the interrupted reply's late deltas/done (they cross the
  // wire after the local cancel) until the next user turn re-arms — otherwise a
  // straggler delta gets the new epoch and is blurted over the user. Re-opened when a
  // new user turn is sent.
  private acceptingReply = true;
  // Audio segments that arrived while the previous one was still finalizing (slow STT
  // on CPU/WASM) — deferred, not dropped, then re-processed so no speech is lost.
  private deferred: Float32Array[] = [];

  // Accept a pre-primed player so audio can be unlocked DURING the Start click
  // (iOS blocks audio started after an await — see useLiveSession.start).
  constructor(private h: VoiceEngineHandlers, player?: AudioPlayer) { this.player = player ?? new AudioPlayer(); }

  async start(stream: MediaStream) {
    this.player.resume();
    // VAD sensitivity + trailing silence come from the user's pipeline config;
    // baked into MicVAD at construction, so edits apply on the next start().
    const vadCfg = loadPipelineConfig().vad;
    this.vad = await MicVAD.new({
      model: "v5",
      // Silero worklet + onnx + ort wasm are vendored into /public/vad by
      // scripts/copy-voice-assets.mjs (predev/prebuild) — served same-origin,
      // no CDN dependency, versions track package.json.
      baseAssetPath: "/vad/",
      onnxWASMBasePath: "/vad/",
      getStream: async () => stream,             // our stream: chosen device + AEC on
      positiveSpeechThreshold: vadCfg.speechThreshold, // lower → picks up soft speech + faster barge-in
      negativeSpeechThreshold: Math.max(0.1, vadCfg.speechThreshold - 0.15),
      minSpeechMs: 250,
      // Wait through short natural pauses before ending a turn. Kept modest because
      // Smart-Turn v3 (semantic end-of-turn) + the mid-thought hold below already
      // catch premature ends — so we don't need a long silence buffer, and shaving it
      // takes real latency off every turn. ponytail: raise toward 700 if it starts
      // cutting slow talkers off mid-sentence.
      redemptionMs: vadCfg.redemptionMs,
      onSpeechStart: () => this.onSpeechStart(),
      onSpeechEnd: (audio) => { void this.onSpeechEnd(audio); },
      onFrameProcessed: (_p, frame) => this.onFrame(frame),
      onVADMisfire: () => { if (this.phase === "listening") this.setPhase("idle"); },
    });
    await this.vad.start();
    this.setupMicSpectrum(stream);
    this.setPhase("idle");
  }

  // Tap the mic stream with an AnalyserNode for a live frequency spectrum. Runs
  // alongside the VAD (a MediaStream feeds many consumers); the analyser isn't
  // connected onward, so nothing is played back (no echo).
  private setupMicSpectrum(stream: MediaStream) {
    try {
      try { this.micSrc?.disconnect(); } catch { /* */ }
      if (!this.specCtx) this.specCtx = new AudioContext();
      const ctx = this.specCtx;
      const a = ctx.createAnalyser();
      a.fftSize = 256;
      a.smoothingTimeConstant = 0.6;
      this.micSrc = ctx.createMediaStreamSource(stream);
      // analyser → muted gain → destination: some engines only process an analyser
      // that's in a path to the destination. Gain 0 → silent (no echo).
      const mute = ctx.createGain();
      mute.gain.value = 0;
      this.micSrc.connect(a);
      a.connect(mute);
      mute.connect(ctx.destination);
      this.micAnalyser = a;
      this.micFreq = new Uint8Array(a.frequencyBinCount);
    } catch { this.micAnalyser = null; /* spectrum is best-effort */ }
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
    // Barge-in: the user talks over the agent — whether it's SPEAKING, or still
    // THINKING/working (e.g. a coding agent running tools or editing). Cancel the
    // in-flight turn AND the agent's execution (the server aborts the turn, which
    // fires ACP session/cancel). The onset grace applies only while speaking, so the
    // agent's own first syllable (echoed through the mic) can't self-trigger.
    const speaking = this.phase === "speaking" || this.player.level() > 0;
    const thinking = this.phase === "thinking";
    // Playback-aware gate: on SPEAKERS the browser's AEC leaks some of the agent's
    // own voice back into the mic. While agent audio is playing, require the mic's
    // smoothed RMS to clear the noise gate scaled UP with the playback level —
    // real speech over the top clears it, residual echo doesn't. Headphones
    // (agentLevel high but zero acoustic leak) still barge instantly because the
    // user's voice is the only mic energy. ponytail: linear 2× scale; tune the
    // factor if speaker echo still self-triggers on some hardware.
    const echoSafe = !speaking || this.micRms > this.gate() * (1 + 2 * this.player.level());
    if (((thinking && !speaking) || (speaking && Date.now() - this.speakingStartAt > ONSET_GRACE_MS)) && echoSafe && !this.h.holdBargeIn?.()) {
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
    // A segment ended while the previous one is still finalizing (STT + turn detection
    // take real time on CPU/WASM). DON'T drop it — defer and re-process below, or the
    // user's words vanish.
    if (this.finalizing) { this.deferred.push(audio); return; }
    const combined = this.pending ? this.concat([this.pending, audio], this.pending.length + audio.length) : audio;
    // Reject blips and near-silence up front (ambient noise that tripped the VAD) —
    // but during push-to-talk a blip must not throw away what's already held.
    if (combined.length < MIN_UTTER_SAMPLES || rmsOf(audio) < this.gate()) { if (!this.ptt) { this.pending = null; this.h.onPartial(""); } if (this.phase === "listening") this.setPhase("idle"); return; }
    this.finalizing = true;
    const perf0 = performance.now();
    try {
      // Transcribe AND ask Smart-Turn (semantic end-of-turn) in parallel. If the
      // turn model isn't loaded, fall back to the VAD's silence endpointing.
      // "silence" turn engine skips Smart-Turn entirely and lets the VAD's trailing
      // silence (redemptionMs) end the turn; "smart-turn" uses the semantic model.
      const turnCfg = loadPipelineConfig().turn;
      // While push-to-talk is held, no end-of-turn decision at all: just accumulate
      // and caption — release (endPtt) is the one and only turn boundary.
      const useTurnModel = !this.ptt && turnModelReady() && turnCfg.engine !== "silence";
      const [text, modelComplete] = await Promise.all([
        stt(combined).then((t) => t.trim()),
        useTurnModel ? turnComplete(combined, turnCfg.threshold) : Promise.resolve(true),
      ]);
      const sttEndpointMs = performance.now() - perf0;
      console.debug(`[live:perf] transcribe+turn ${Math.round(sttEndpointMs)}ms`);
      if (this.ptt) { this.pending = combined; if (!isJunk(text)) this.h.onPartial(text); this.setPhase("idle"); return; }
      // Drop empties and Whisper's silence-hallucinations so background noise and
      // dead air never fire a turn.
      if (isJunk(text)) { this.pending = null; this.h.onPartial(""); this.setPhase("idle"); return; }
      // Hold through a mid-thought pause (model says "not done", or the words
      // trail off) instead of cutting in — but never longer than the configured
      // hold / 20 s.
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
      this.acceptingReply = true; // re-arm: this turn's reply should be voiced
      this.turnSentAt = performance.now();
      perf.turnCommitted(sttEndpointMs);
      this.h.onUserText(text);
    } catch {
      // A stalled/failed inference (now time-limited in models.call) must not strand
      // the turn loop — recover to idle and clear the frozen partial caption.
      this.pending = null; this.h.onPartial(""); this.setPhase("idle");
    } finally {
      this.finalizing = false;
      // Speech that arrived mid-finalize: merge it and process as a continuation
      // (onSpeechEnd folds in `pending`, so a mid-thought hold still coalesces).
      if (this.deferred.length) {
        const parts = this.deferred; this.deferred = [];
        const merged = this.concat(parts, parts.reduce((n, p) => n + p.length, 0));
        void this.onSpeechEnd(merged);
      }
    }
  }

  private scheduleHold() {
    this.clearHold();
    const holdMs = loadPipelineConfig().turn.holdMs;
    this.holdTimer = setTimeout(() => this.flushPending(), holdMs);
    this.h.onHold({ until: Date.now() + holdMs });
  }
  /** Send the held mid-thought utterance NOW (hold timer fired, or the user tapped
   *  "send now" / hit Enter instead of waiting it out). */
  private flushPending() {
    const p = this.pending; this.pending = null;
    this.clearHold();
    if (!p || this.phase !== "idle") return;
    void stt(p).then((t) => {
      const text = t.trim();
      if (text && !isJunk(text)) { this.setPhase("thinking"); this.spokenText = ""; this.acceptingReply = true; this.turnSentAt = performance.now(); this.h.onUserText(text); }
      else this.h.onPartial(""); // held fragment came back empty/junk → clear the caption
    }).catch(() => this.h.onPartial("")); // stalled/failed STT → don't strand the caption
  }
  /** Public "send now": commit a held utterance without waiting for the hold timer. */
  commitPending() { if (this.pending && !this.ptt) this.flushPending(); }
  private clearHold() { if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; this.h.onHold(null); } }

  // ── push-to-talk ────────────────────────────────────────────────────────
  /** Hold-to-talk pressed: barge in if the agent is mid-reply, unmute if needed,
   *  and suspend all auto end-of-turn — release is the turn boundary. */
  beginPtt() {
    if (this.ptt || !this.vad) return;
    this.ptt = true;
    this.clearHold(); // keep `pending`: PTT continues an already-held thought
    if ((this.phase === "speaking" || this.phase === "thinking" || this.player.level() > 0) && !this.h.holdBargeIn?.()) this.bargeIn();
    if (this.muted) void this.vad.start(); // lift a mute for the hold (restored on release)
  }
  /** Released: everything accumulated (held segments + the in-flight one) is the turn.
   *  PTT stays "on" until the VAD closes the in-flight segment, so onSpeechEnd files
   *  it into `pending` (the ptt branch) instead of racing an auto end-of-turn. */
  async endPtt() {
    if (!this.ptt) return;
    // The user just stopped talking: the VAD ends the segment after redemptionMs of
    // silence, then onSpeechEnd (ptt branch) appends it to `pending`. Bounded wait.
    for (let i = 0; i < 40 && (this.phase === "listening" || this.finalizing); i++) await new Promise((r) => setTimeout(r, 50));
    this.ptt = false;
    if (this.muted) void this.vad?.pause(); // the hold is over — restore the mute
    const p = this.pending;
    this.pending = null;
    if (!p || p.length < MIN_UTTER_SAMPLES) { this.h.onPartial(""); if (this.phase === "listening") this.setPhase("idle"); return; }
    try {
      const text = (await stt(p)).trim();
      if (isJunk(text)) { this.h.onPartial(""); this.setPhase("idle"); return; }
      this.setPhase("thinking");
      this.spokenText = "";
      this.acceptingReply = true;
      this.turnSentAt = performance.now();
      this.h.onUserText(text);
    } catch { this.h.onPartial(""); this.setPhase("idle"); }
  }
  pttActive() { return this.ptt; }

  // ── agent reply → speech ───────────────────────────────────────────────
  feedAgentDelta(text: string) {
    if (!this.acceptingReply) return; // interrupted reply's straggler deltas — don't voice them
    perf.firstToken(); // no-op after the first delta of a turn
    for (const s of this.chunker.push(text)) this.enqueueSpeak(s, this.epoch);
  }
  endAgentTurn() {
    if (!this.acceptingReply) return; // the barged reply's `done` — no tail to flush/voice
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

  private enqueueSpeak(sentence: string, epoch: number, outOfBand = false) {
    this.ttsChain = this.ttsChain.then(async () => {
      if (this.epoch !== epoch) return; // barged-in → drop stale speech
      const spoken = stripMarkdown(sentence);
      if (!spoken) return;
      // Read voice/speed per sentence so a settings change applies to the next reply.
      const ttsCfg = loadPipelineConfig().tts;
      const { audio, sampleRate } = await tts(spoken, { engine: ttsCfg.engine, voice: ttsCfg.voice, speed: ttsCfg.speed });
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
        // Out-of-band lines (say(): errors, reminders) are VOICED but are not the
        // model's reply — keep them out of `spokenText` (barge-in cutoff) and out of
        // onAgentText (which the client persists into the transcript), or they get
        // saved as if the assistant said them and contaminate the cutoff.
        if (outOfBand) return;
        // Accumulate ONLY as each chunk actually begins playing — so on barge-in
        // `spokenText` is exactly what was voiced, and the unspoken (still-queued)
        // tail is excluded from the saved history.
        this.spokenText += (this.spokenText ? " " : "") + spoken;
        this.h.onAgentText(spoken, durationMs);
      });
    }).catch((e) => { log.warn("live", "TTS failed:", e?.message ?? e); });
  }

  /** Speak a short out-of-band line (e.g. an agent failure) through the same
   *  TTS chain — voice-first users hear problems, not just see banners. */
  say(text: string) {
    const t = text.trim();
    if (t) this.enqueueSpeak(t, this.epoch, true /* out-of-band: voice it, don't persist it */);
  }

  private bargeIn() {
    this.epoch++;
    this.acceptingReply = false; // ignore the interrupted reply's remaining deltas until the next turn
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

  /** Mute (manual / hands-free toggle): pause listening; a held pending is dropped. */
  setMuted(muted: boolean) {
    this.muted = muted;
    if (!this.vad) return;
    if (muted) { this.clearHold(); this.pending = null; this.micRms = 0; void this.vad.pause(); if (this.phase === "listening") this.setPhase("idle"); }
    else void this.vad.start();
  }

  micLevel() { return this.micRms; }
  agentLevel() { return this.player.level(); }
  /** N octave-band magnitudes (0..1) of YOUR voice — a real spectrum for the orb. */
  micBands(n = 5): number[] {
    if (!this.micAnalyser || !this.micFreq) return new Array(n).fill(0);
    this.micAnalyser.getByteFrequencyData(this.micFreq as Uint8Array<ArrayBuffer>);
    return octaveBands(this.micFreq, n);
  }
  /** Same, for the agent's voice while it speaks. */
  agentBands(n = 5): number[] { return this.player.agentBands(n); }

  stop() {
    this.clearHold();
    this.ptt = false;
    this.epoch++;
    try { this.vad?.destroy(); } catch { /* */ }
    this.vad = null;
    try { this.micSrc?.disconnect(); } catch { /* */ }
    try { void this.specCtx?.close(); } catch { /* */ }
    this.micSrc = null; this.micAnalyser = null; this.micFreq = null; this.specCtx = null;
    this.player.close();
  }
}
