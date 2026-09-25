import { MicVAD } from "@ricky0123/vad-web";
import { AudioPlayer } from "./audioPlayback";
import { stt, ttsStream, hasWebGPU, turnComplete, turnModelReady, activeSttEngine, nativeSttFailed, resetNativeFallbacks, warmNativeEngines } from "./models";
import { isJunk, endsMidThought, stripMarkdown, toSpeech, estimateSpeechMs, SentenceChunker } from "./voiceText";
import { octaveBands } from "./spectrum";
import { perf } from "./perf";
import { loadPipelineConfig, variantInfo } from "./pipelineConfig";
import type { LanguageCode } from "@openlive/shared";
import { AsrStream } from "./asrStream";
import { FrameRing } from "./pcm";
import { log } from "@/lib/log";

// The on-device conversation loop (replaces the old server pipeline). Silero VAD
// segments the user's speech; the selected STT engine transcribes it (Whisper in
// the browser or a native engine on the local agent: partials + a final, or a
// socket that transcribes while the user talks); a light "mid-thought" check
// holds through natural pauses; the final text goes to the server; the LLM's
// reply text streams back and is spoken by the selected TTS engine, chunk by
// chunk when it streams. Barge-in is a LOCAL decision, no server round-trip for audio.
export type EnginePhase = "idle" | "listening" | "thinking" | "speaking";

export interface VoiceEngineHandlers {
  onPhase: (p: EnginePhase) => void;
  onPartial: (text: string) => void;      // interim user caption (greyed)
  onUserText: (text: string) => void;      // final user turn → send to server
  onAgentText: (sentence: string, durationMs: number) => void; // agent caption chunk + how long it plays (for word-timed reveal)
  onBargeIn: (spoken?: string) => void;     // cancel the LLM stream; `spoken` = what was actually voiced so far, undefined before this reply arrived
  // A mid-thought pause is being held: `until` = when it auto-sends (UI shows a
  // "waiting for you… tap to send" affordance); null = hold resolved/cancelled.
  onHold: (h: { until: number } | null) => void;
  /** True while user speech must NOT barge in — e.g. a permission ask is pending
   *  and the next utterance IS the answer. Cancelling there killed the very ask
   *  the user was answering (the chip vanished the moment they spoke). */
  holdBargeIn?: () => boolean;
  /** The mic track ended on its own: unplugged, or its permission revoked. The
   *  surface re-acquires a device and hands it to setStream. */
  onMicLost?: () => void;
}

/**
 * Turn-taking numbers for a surface that needs different ones from the user's
 * saved pipeline.
 *
 * Flow is the case this exists for: in a call the person can see the caption
 * and press a key, and being cut off early costs them a click. Hands-free there
 * is no key and no screen, so a sentence cut in half is sent, answered and
 * acted on before they can say the rest of it.
 */
export interface TurnTuning { threshold?: number; holdMs?: number; redemptionMs?: number }

const PARTIAL_MS = 500;      // min gap between interim transcriptions
const ONSET_GRACE_MS = 250;  // agent's own first syllable can't self-trigger barge-in
const MIN_UTTER_SAMPLES = 16000 * 0.25; // ignore <0.25s blips
const RMS_GATE = 0.006;      // reject near-silence; low enough to hear a soft talker
// vad-web 0.0.31 starts a segment preSpeechPadMs (default 800) before speech was
// detected, in 512-sample (32 ms) frames: 25 of them plus the frame that tripped it.
// A streamed utterance sends the same audio from the same point.
const PRE_SPEECH_FRAMES = Math.floor(800 / 32) + 1;
// The agent unloads a native engine after 5 idle minutes (native-worker.ts), so
// a long think or a quiet stretch mid-call would load it cold under the next
// sentence. A tick well inside that keeps it loaded; warmNativeEngines skips an
// engine that served a real request in the last minute.
const KEEP_WARM_MS = 2 * 60_000;

/** The TTS settings one reply is spoken with. */
type ReplyVoice = { engine: string; family: string; voice: string; speed: number; lang: LanguageCode };
const voiceNow = (): ReplyVoice => {
  const { tts, language } = loadPipelineConfig();
  return { engine: tts.variant, family: tts.family, voice: tts.voice, speed: tts.speed, lang: language };
};

function rmsOf(a: Float32Array): number { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * a[i]!; return Math.sqrt(s / a.length); }

export class VoiceEngine {
  private vad: MicVAD | null = null;
  private player: AudioPlayer;
  private chunker = new SentenceChunker();
  private phase: EnginePhase = "idle";

  private pending: Float32Array | null = null;   // held mid-thought utterance
  private pendingText = "";                        // its transcript, already computed in onSpeechEnd — reused on auto-send instead of re-transcribing
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private curBuf: Float32Array[] = [];           // frames since speech start (for partials)
  private curLen = 0;
  private lastPartialAt = 0;
  private partialMs = 0;                          // how long the last interim transcription took
  private partialBusy = false;
  private partialAbort: AbortController | null = null; // the interim transcription in flight
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
  // Until this reply's first delta, a barge-in has nothing of it to cut: the server
  // may not even have the utterance yet, and an empty cut would wipe the reply before.
  private replyFed = false;
  // Fixed at the reply's first delta, so a settings change mid-reply applies
  // from the next one instead of switching voice between two sentences.
  private replyVoice: ReplyVoice | null = null;
  // After a barge-in, IGNORE the interrupted reply's late deltas/done (they cross the
  // wire after the local cancel) until the next user turn re-arms — otherwise a
  // straggler delta gets the new epoch and is blurted over the user. Re-opened when a
  // new user turn is sent.
  private acceptingReply = true;
  // The segment in progress started as the agent's own voice through the speakers.
  private echo = false;
  // Audio segments that arrived while the previous one was still finalizing (slow STT
  // on CPU/WASM) — deferred, not dropped, then re-processed so no speech is lost.
  private deferred: { audio: Float32Array; final?: Promise<string> }[] = [];
  private asr: AsrStream | null = null;          // open while the active STT engine streams
  private streaming = false;                      // this utterance's frames are going up the socket
  private ring = new FrameRing(PRE_SPEECH_FRAMES); // recent frames, sent when speech starts
  private uttEngine = "whisper";                  // the STT variant this utterance started on
  private ttsAbort: AbortController | null = null; // the sentence being synthesized, cut by barge-in
  private micTrack: MediaStreamTrack | null = null;
  private keepWarm: ReturnType<typeof setInterval> | undefined;
  // "ended" fires only when the browser ends a track, never for our own stop().
  private onMicEnded = () => this.h.onMicLost?.();

  // Accept a pre-primed player so audio can be unlocked DURING the Start click
  // (iOS blocks audio started after an await — see useLiveSession.start).
  constructor(private h: VoiceEngineHandlers, player?: AudioPlayer, private tuning: TurnTuning = {}) {
    this.player = player ?? new AudioPlayer();
    resetNativeFallbacks();
  }

  /** Opens or closes the streaming socket to match the engine in use now, so an
   *  engine switch or a fallback mid-call applies from the next utterance. */
  private syncAsr() {
    const e = activeSttEngine();
    const lang = loadPipelineConfig().language;
    if (this.asr?.engine === e && this.asr.lang === lang) return;
    this.asr?.close();
    this.asr = null;
    if (!variantInfo(e)?.variant.streaming) return;
    this.asr = new AsrStream(e, lang, {
      onPartial: (text) => {
        if (this.streaming && this.phase === "listening" && text && !isJunk(text)) this.h.onPartial(this.pending ? `${this.pendingText} ${text}` : text);
      },
      onRefused: (why) => nativeSttFailed(e, new Error(why), true),
    });
  }

  /** The VAD closed a segment: ask the socket for its final, if it was streamed. */
  private endStream(): Promise<string> | undefined {
    if (!this.streaming) return undefined;
    this.streaming = false;
    const final = this.asr!.end();
    final.catch(() => { /* handled where it is awaited; this only marks it handled while deferred */ });
    return final;
  }

  /** The user's saved turn-taking, with this surface's overrides on top. */
  private turnCfg() {
    const { turn, vad } = loadPipelineConfig();
    return {
      threshold: this.tuning.threshold ?? turn.threshold,
      holdMs: this.tuning.holdMs ?? turn.holdMs,
      redemptionMs: this.tuning.redemptionMs ?? vad.redemptionMs,
      engine: turn.engine,
    };
  }

  async start(stream: MediaStream) {
    this.micTrack?.removeEventListener("ended", this.onMicEnded);
    this.micTrack = stream.getAudioTracks()[0] ?? null;
    this.micTrack?.addEventListener("ended", this.onMicEnded);
    this.player.resume();
    // VAD sensitivity + trailing silence come from the user's pipeline config;
    // baked into MicVAD at construction, so edits apply on the next start().
    const vadCfg = { ...loadPipelineConfig().vad, redemptionMs: this.turnCfg().redemptionMs };
    this.vad = await MicVAD.new({
      model: vadCfg.model,
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
      onSpeechEnd: (audio) => { void this.onSpeechEnd(audio, this.endStream()); },
      onFrameProcessed: (_p, frame) => this.onFrame(frame),
      onVADMisfire: () => { this.streaming = false; if (this.phase === "listening") this.setPhase("idle"); },
    });
    this.syncAsr();
    warmNativeEngines();
    clearInterval(this.keepWarm);
    this.keepWarm = setInterval(warmNativeEngines, KEEP_WARM_MS);
    // A device swap rebuilds the VAD through here, and a muted mic must stay muted.
    if (!this.muted || this.ptt) await this.vad.start();
    this.setupMicSpectrum(stream);
    // Only a segment the old VAD was hearing is gone; a reply keeps its phase.
    if (this.phase === "listening") this.setPhase("idle");
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
    this.streaming = false;
    this.ring.clear();
    void this.vad?.destroy().catch(() => { /* */ });
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
    const holding = this.h.holdBargeIn?.();
    if (((thinking && !speaking) || (speaking && Date.now() - this.speakingStartAt > ONSET_GRACE_MS)) && echoSafe && !holding) {
      this.bargeIn();
    } else if (holding && echoSafe && (speaking || this.player.level() > 0)) {
      // A permission/elicitation modal is open and the user is answering it — stop the
      // agent's question audio LOCALLY so the mic captures a clean answer (no echo/
      // talk-over), but NEVER send a cancel: barging would kill the very ask being
      // answered (that's why holdBargeIn is set). The utterance still finalizes and
      // routes to the modal.
      this.hush();
    } else if (speaking) {
      // The agent's own voice leaking back: not a turn. Nothing is heard, sent or cut,
      // and the phase stays on the reply; onSpeechEnd drops the segment.
      this.echo = true;
      return;
    }
    this.echo = false;
    this.clearHold();
    this.curBuf = []; this.curLen = 0; this.partialMs = 0;
    this.syncAsr();
    this.uttEngine = activeSttEngine();
    this.streaming = !!this.asr?.live;
    if (this.streaming) { this.asr!.reset(); this.asr!.send(this.ring.drain()); }
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
    if (this.streaming) { this.asr!.send(frame); return; }
    if (this.asr) this.ring.push(frame);
    if (this.phase !== "listening") return;
    this.curBuf.push(frame); this.curLen += frame.length;
    void this.maybePartial();
  }

  // Reject threshold: the fixed floor, or a margin above the learned room noise
  // (whichever is higher), capped so it can't rise enough to reject real speech.
  private gate(): number { return Math.min(0.03, Math.max(RMS_GATE, this.noiseFloor * 1.6)); }

  // Interim caption while speaking. Whisper only on WebGPU (too slow to be useful
  // on WASM); a native batch engine runs on the agent's CPU, fast either way; a
  // streaming engine sends its own partials.
  private async maybePartial() {
    if ((this.uttEngine === "whisper" && !hasWebGPU()) || this.asr || this.partialBusy || this.finalizing) return;
    const now = Date.now();
    // Each partial re-transcribes the whole utterance so far, so its cost grows
    // with it: spacing them by twice that cost keeps a long monologue from
    // holding the STT engine flat out, with the final queued behind.
    if (now - this.lastPartialAt < Math.max(PARTIAL_MS, 2 * this.partialMs) || this.curLen < MIN_UTTER_SAMPLES) return;
    this.lastPartialAt = now;
    this.partialBusy = true;
    const abort = this.partialAbort = new AbortController();
    try {
      const win = this.concat(this.curBuf, this.curLen);
      if (rmsOf(win) < this.gate()) return;
      const text = await stt(win, abort.signal);
      if (text && !isJunk(text) && this.phase === "listening") this.h.onPartial(text);
    } catch { /* best-effort */ }
    finally { this.partialBusy = false; this.partialMs = Date.now() - now; if (this.partialAbort === abort) this.partialAbort = null; }
  }

  // `final` is the streamed transcript of `audio` alone, when it was streamed.
  private async onSpeechEnd(audio: Float32Array, final?: Promise<string>) {
    if (this.echo) { this.echo = false; return; }
    // The agent runs one transcription at a time: a caption still queued there
    // would make the final wait for it.
    this.partialAbort?.abort();
    // A segment ended while the previous one is still finalizing (STT + turn detection
    // take real time on CPU/WASM). DON'T drop it — defer and re-process below, or the
    // user's words vanish.
    if (this.finalizing) { this.deferred.push({ audio, final }); return; }
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
      const turnCfg = this.turnCfg();
      // While push-to-talk is held, no end-of-turn decision at all: just accumulate
      // and caption — release (endPtt) is the one and only turn boundary.
      const useTurnModel = !this.ptt && turnModelReady() && turnCfg.engine !== "silence";
      // A streamed final covers this segment only; a held one is already transcribed.
      const prefix = this.pending ? this.pendingText : "";
      const transcript = final
        ? final.then((t) => [prefix, t.trim()].filter(Boolean).join(" ")).catch(() => stt(combined))
        : stt(combined);
      const [text, modelComplete] = await Promise.all([
        transcript.then((t) => t.trim()),
        useTurnModel ? turnComplete(combined, turnCfg.threshold) : Promise.resolve(true),
      ]);
      const sttEndpointMs = performance.now() - perf0;
      if (this.ptt) { this.pending = combined; this.pendingText = text; if (!isJunk(text)) this.h.onPartial(text); this.setPhase("idle"); return; }
      // Drop empties and Whisper's silence-hallucinations so background noise and
      // dead air never fire a turn.
      if (isJunk(text)) { this.pending = null; this.h.onPartial(""); this.setPhase("idle"); return; }
      // Hold through a mid-thought pause (model says "not done", or the words
      // trail off) instead of cutting in — but never longer than the configured
      // hold / 20 s.
      const done = modelComplete && !endsMidThought(text, loadPipelineConfig().language);
      if (!done && combined.length < 16000 * 20) {
        this.pending = combined;
        this.pendingText = text;
        this.h.onPartial(text);
        this.scheduleHold();
        this.setPhase("idle");
        return;
      }
      this.pending = null;
      this.clearHold();
      this.setPhase("thinking");
      this.spokenText = ""; // new turn: clear the previous reply's spoken text
      this.replyFed = false;
      this.replyVoice = null;
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
        const merged = this.concat(parts.map((p) => p.audio), parts.reduce((n, p) => n + p.audio.length, 0));
        const finals = parts.every((p) => p.final)
          ? Promise.all(parts.map((p) => p.final!)).then((ts) => ts.map((t) => t.trim()).filter(Boolean).join(" "))
          : undefined;
        void this.onSpeechEnd(merged, finals);
      }
    }
  }

  private scheduleHold() {
    this.clearHold();
    const holdMs = this.turnCfg().holdMs;
    this.holdTimer = setTimeout(() => this.flushPending(), holdMs);
    this.h.onHold({ until: Date.now() + holdMs });
  }
  /** Send the held mid-thought utterance NOW (hold timer fired, or the user tapped
   *  "send now" / hit Enter instead of waiting it out). */
  private flushPending() {
    const p = this.pending; const cached = this.pendingText.trim();
    this.pending = null; this.pendingText = "";
    this.clearHold();
    if (!p || this.phase !== "idle") return;
    const commit = (t: string) => {
      const text = t.trim();
      if (text && !isJunk(text)) { this.setPhase("thinking"); this.spokenText = ""; this.replyFed = false; this.replyVoice = null; this.acceptingReply = true; this.turnSentAt = performance.now(); perf.turnCommitted(0); this.h.onUserText(text); }
      else this.h.onPartial(""); // held fragment came back empty/junk → clear the caption
    };
    // The held audio was already transcribed in onSpeechEnd (that's how we knew it
    // was mid-thought), so reuse that transcript instead of re-running STT here —
    // the auto-send path was paying for a second transcription. Fall back to STT
    // only if for some reason we don't have the cached text.
    if (cached) commit(cached);
    else void stt(p).then(commit).catch(() => this.h.onPartial("")); // stalled/failed STT → don't strand the caption
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
    const p = this.pending; const cached = this.pendingText;
    this.pending = null;
    if (!p || p.length < MIN_UTTER_SAMPLES) { this.h.onPartial(""); if (this.phase === "listening") this.setPhase("idle"); return; }
    const perf0 = performance.now();
    try {
      // `pendingText` is always the transcript of exactly `pending`.
      const text = (cached || (await stt(p))).trim();
      if (isJunk(text)) { this.h.onPartial(""); this.setPhase("idle"); return; }
      this.setPhase("thinking");
      this.spokenText = "";
      this.replyFed = false;
      this.replyVoice = null;
      this.acceptingReply = true;
      this.turnSentAt = performance.now();
      perf.turnCommitted(this.turnSentAt - perf0);
      this.h.onUserText(text);
    } catch { this.h.onPartial(""); this.setPhase("idle"); }
  }
  pttActive() { return this.ptt; }

  // ── agent reply → speech ───────────────────────────────────────────────
  feedAgentDelta(text: string) {
    if (!this.acceptingReply) return; // interrupted reply's straggler deltas — don't voice them
    this.replyFed = true;
    perf.firstToken(); // no-op after the first delta of a turn
    const v = this.replyVoice ??= voiceNow();
    for (const s of this.chunker.push(text, v.lang)) this.enqueueSpeak(s, this.epoch, v);
  }
  /** A tool is about to run: voice everything said so far now. Held for the
   *  length bar, its tail spoke only after the tool, cut off mid-sentence. */
  endAgentStep() {
    if (!this.acceptingReply) return;
    const said = this.chunker.flush();
    if (said) this.enqueueSpeak(said, this.epoch, this.replyVoice ?? voiceNow());
  }
  endAgentTurn() {
    if (!this.acceptingReply) return; // the barged reply's `done` — no tail to flush/voice
    const tail = this.chunker.flush();
    if (tail) this.enqueueSpeak(tail, this.epoch, this.replyVoice ?? voiceNow());
    this.replyVoice = null;
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

  private enqueueSpeak(sentence: string, epoch: number, v: ReplyVoice, outOfBand = false) {
    this.ttsChain = this.ttsChain.then(async () => {
      if (this.epoch !== epoch) return; // barged-in → drop stale speech
      const spoken = stripMarkdown(sentence);
      if (!spoken) return;
      const abort = new AbortController();
      this.ttsAbort = abort;
      // A streaming engine hands over the sentence in pieces; the chain still waits
      // for all of them, so sentences play in order while the next one synthesizes
      // under the current one's playback.
      let samples = 0, rate = 24000, synthDone = false, first = true;
      try {
        await ttsStream(toSpeech(spoken, v.lang), { engine: v.engine, voice: v.voice, speed: v.speed, lang: v.lang }, (audio, sampleRate) => {
          if (this.epoch !== epoch) return;
          samples += audio.length; rate = sampleRate;
          if (this.phase !== "speaking") {
            this.speakingStartAt = Date.now(); this.setPhase("speaking");
            if (this.turnSentAt) { this.turnSentAt = 0; perf.firstAudio(); }
          }
          // Show the caption for THIS sentence when its first piece actually starts
          // playing (not now, when it was synthesized: synth runs ahead of the voice),
          // so the subtitle reads out only the words being spoken right now.
          const onStart = first ? () => {
            if (this.epoch !== epoch) return;
            // Out-of-band lines (say(): errors, reminders) are VOICED but are not the
            // model's reply: keep them out of `spokenText` (barge-in cutoff) and out of
            // onAgentText (which the client persists into the transcript), or they get
            // saved as if the assistant said them and contaminate the cutoff.
            if (outOfBand) return;
            // Accumulate ONLY as each sentence actually begins playing, so on barge-in
            // `spokenText` is exactly what was voiced, and the unspoken (still-queued)
            // tail is excluded from the saved history.
            this.spokenText += (this.spokenText ? " " : "") + spoken;
            // How long the sentence voices paces the caption reveal: exact once
            // synthesis is done (always, for a one-piece engine), else estimated.
            this.h.onAgentText(spoken, synthDone ? (samples / rate) * 1000 : estimateSpeechMs(spoken, v.family, v.speed, v.lang));
          } : undefined;
          first = false;
          this.player.play(audio, epoch, sampleRate, onStart);
        }, abort.signal);
        // No voice speaks the language: the words still reach the caption and transcript.
        if (first && !outOfBand && this.epoch === epoch && !abort.signal.aborted) {
          this.spokenText += (this.spokenText ? " " : "") + spoken;
          this.h.onAgentText(spoken, estimateSpeechMs(spoken, v.family, v.speed, v.lang));
        }
      } finally {
        synthDone = true;
        if (this.ttsAbort === abort) this.ttsAbort = null;
      }
    }).catch((e) => { log.warn("live", "TTS failed:", e?.message ?? e); });
  }

  /** Speak a short out-of-band line (e.g. an agent failure) through the same
   *  TTS chain — voice-first users hear problems, not just see banners. */
  say(text: string) {
    const t = text.trim();
    // In the reply's voice when it lands mid-reply.
    if (t) this.enqueueSpeak(t, this.epoch, this.replyVoice ?? voiceNow(), true /* out-of-band: voice it, don't persist it */);
  }

  // Stop the agent's LOCAL audio without telling the server (no cancel). Used to
  // silence a modal's spoken question the instant the user answers it. Does NOT set
  // acceptingReply=false: the turn CONTINUES after the modal answer, so its follow-up
  // speech must still be voiced (that flag is barge-in only).
  private hush() {
    this.epoch++;
    this.ttsAbort?.abort();
    this.player.flush(this.epoch);
    this.chunker.flush();
    this.replyVoice = null;
    // The new epoch strands the drain that would have idled a speaking or thinking reply.
    if (this.phase !== "listening") this.setPhase("idle");
  }

  private bargeIn() {
    this.h.onBargeIn(this.cutReply());
  }

  /** Silence the reply and drop the rest of it, returning what was actually
   *  voiced. Barge-in and a Stop button are the same cut from two directions. */
  cutReply(): string | undefined {
    this.acceptingReply = false; // ignore the interrupted reply's remaining deltas until the next turn
    this.hush();
    return this.replyFed ? this.spokenText.trim() : undefined;
  }

  // ── helpers / lifecycle ────────────────────────────────────────────────
  private concat(parts: Float32Array[], total: number): Float32Array {
    const out = new Float32Array(total); let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }
  /** Where the turn loop is now. onPhase reports only changes, so a surface that
   *  set its own phase meanwhile reads this to get back in step. */
  currentPhase() { return this.phase; }
  private setPhase(p: EnginePhase) { if (p !== this.phase) { this.phase = p; this.h.onPhase(p); } }

  /** Mute (manual / hands-free toggle): pause listening; a held pending is dropped. */
  setMuted(muted: boolean) {
    this.muted = muted;
    if (!this.vad) return;
    if (muted) { this.clearHold(); this.pending = null; this.streaming = false; this.ring.clear(); this.micRms = 0; void this.vad.pause(); if (this.phase === "listening") this.setPhase("idle"); }
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
    clearInterval(this.keepWarm);
    this.clearHold();
    this.ptt = false;
    this.epoch++;
    this.ttsAbort?.abort();
    this.partialAbort?.abort();
    this.micTrack?.removeEventListener("ended", this.onMicEnded);
    this.micTrack = null;
    this.asr?.close();
    this.asr = null;
    this.streaming = false;
    void this.vad?.destroy().catch(() => { /* */ });
    this.vad = null;
    try { this.micSrc?.disconnect(); } catch { /* */ }
    try { void this.specCtx?.close(); } catch { /* */ }
    this.micSrc = null; this.micAnalyser = null; this.micFreq = null; this.specCtx = null;
    this.player.close();
  }
}
