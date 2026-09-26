import { MicVAD } from "@ricky0123/vad-web";
import { AudioPlayer } from "./audioPlayback";
import { stt, timedOn, type Heard, ttsStream, hasWebGPU, turnComplete, turnModelReady, activeSttEngine, nativeSttFailed, resetNativeFallbacks, warmNativeEngines } from "./models";
import { isJunk, isBackchannel, endsMidThought, stripMarkdown, speechPieces, estimateSpeechMs, SentenceChunker } from "./voiceText";
import { octaveBands } from "./spectrum";
import { perf } from "./perf";
import { loadPipelineConfig, variantInfo } from "./pipelineConfig";
import type { LanguageCode } from "@openlive/shared";
import { compileLexicon, type Lexicon } from "@openlive/shared/speech/lexicon";
import { normalizeAligned } from "@openlive/shared/speech/normalize";
import { captionOnsets, heardText, paceWords, placeWords, spokenWords } from "@openlive/shared/speech/timing";
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
  onUserText: (text: string, wordsAtMs: number[]) => void; // final user turn → send to server: each captionWords word's onset, ms into the turn's audio (its segments back to back)
  onAgentText: (sentence: string, wordsAtMs: number[]) => void; // agent caption chunk, now voicing: each captionWords word's onset from now
  onAgentTiming?: (wordsAtMs: number[]) => void; // the chunk on screen, timed again once more of its audio is in
  onBargeIn: (spoken?: string) => void;     // cancel the LLM stream; `spoken` = what was actually voiced so far, undefined before this reply arrived
  // A mid-thought pause is being held: `until` = when it auto-sends (UI shows a
  // "waiting for you… tap to send" affordance); null = hold resolved/cancelled.
  onHold: (h: { until: number } | null) => void;
  /** True while user speech must NOT barge in — e.g. a permission ask is pending
   *  and the next utterance IS the answer. Cancelling there killed the very ask
   *  the user was answering (the chip vanished the moment they spoke). */
  holdBargeIn?: () => boolean;
  /** True when `text` settles the pending ask ("yes", "no"): its turn ends at
   *  once, since the turn model calls a bare "Yes." unfinished and would hold it. */
  answersAsk?: (text: string) => boolean;
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
// Voiced time (Silero frames over the speech threshold) past which a sound over
// the reply is taken for talk before its words are in. Measured on macOS voices
// through Silero v6: one backchannel in any of the ten languages voices 256-864 ms
// ("claro, claro" the longest), four laughing "ha"s 992 ms, while "mhm, right,
// okay" said as one runs 1760 ms. Human delivery is slower than a TTS voice's.
const BACKCHANNEL_MAX_MS = 1500;

/** The TTS settings one reply is spoken with, the pronunciation dictionary compiled once for it. */
type ReplyVoice = { engine: string; family: string; voice: string; speed: number; lang: LanguageCode; lexicon: Lexicon | null };
const voiceNow = (): ReplyVoice => {
  const { tts, language, pronunciations } = loadPipelineConfig();
  return { engine: tts.variant, family: tts.family, voice: tts.voice, speed: tts.speed, lang: language, lexicon: compileLexicon(pronunciations, language) };
};

/** `b`, heard after `a`'s `aSamples` of audio, joined onto it. */
const joinHeard = (a: Heard, aSamples: number, b: Heard): Heard =>
  ({ text: [a.text, b.text.trim()].filter(Boolean).join(" "), at: [...a.at, ...b.at.map((t) => t + (1000 * aSamples) / 16000)] });

function rmsOf(a: Float32Array): number { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * a[i]!; return Math.sqrt(s / a.length); }

export class VoiceEngine {
  private vad: MicVAD | null = null;
  private player: AudioPlayer;
  private chunker = new SentenceChunker();
  private phase: EnginePhase = "idle";

  private pending: Float32Array | null = null;   // held mid-thought utterance
  private pendingText = "";                        // its transcript, already computed in onSpeechEnd — reused on auto-send instead of re-transcribing
  private pendingAt: number[] = [];                // pendingText's word onsets in `pending`
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
  // Set by stop(). A transcription still running then must not start a turn in a
  // call that has already ended.
  private stopped = false;

  private micRms = 0;
  // A dedicated analyser on the mic stream → a real frequency spectrum for the orb
  // while YOU talk (the VAD's frames only give amplitude, not per-band energy).
  private specCtx: AudioContext | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private micFreq: Uint8Array | null = null;
  private micSrc: MediaStreamAudioSourceNode | null = null;
  private noiseFloor = 0.002;                     // learned room ambient (see onFrame/gate)
  private epoch = 0;                              // bumped on barge-in; stales TTS + audio
  private captionSeq = 0;                         // counts captions shown: only the one on screen takes a new timing
  private ttsChain: Promise<void> = Promise.resolve();
  private speakingStartAt = 0;
  private turnSentAt = 0;                         // perf: when the final user text went out
  private spokenText = "";                         // what the agent has actually VOICED this reply (for barge-in cutoff)
  // The reply sentence playing now: the reply before it, its caption words' onsets, when it began.
  // `lag`: how long pauses have held it, added to every onset.
  private voicing: { before: string; text: string; at: number[]; t0: number; lag: number } | null = null;
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
  // A reply is under way: from its user turn or first delta to its end or cut. Only
  // then does endAgentTurn idle the engine; a line said outside one idles itself.
  private replyOpen = false;
  // The segment in progress started as the agent's own voice through the speakers.
  private echo = false;
  // The segment in progress cut into the agent's reply: said to be acted on now.
  private barged = false;
  // Talk over the agent pauses its voice until the words say what it was: set
  // to the phase the surface still shows, null once it resumed or was cut.
  private tentative: EnginePhase | null = null;
  private pausedAt = 0;
  private voicedMs = 0;                            // this segment's voiced time while tentative
  private hearing = false;                         // the VAD is inside a segment
  // Audio segments that arrived while the previous one was still finalizing (slow STT
  // on CPU/WASM) — deferred, not dropped, then re-processed so no speech is lost.
  private deferred: { audio: Float32Array; final?: Promise<Heard> }[] = [];
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
        if (this.streaming && this.phase === "listening" && text && !isJunk(text)) this.heardPartial(this.pending ? `${this.pendingText} ${text}` : text);
      },
      onRefused: (why) => nativeSttFailed(e, new Error(why), true),
    });
  }

  /** The VAD closed `audio`: ask the socket for its final, if it was streamed. */
  private endStream(audio: Float32Array): Promise<Heard> | undefined {
    if (!this.streaming) return undefined;
    this.streaming = false;
    const lang = loadPipelineConfig().language;
    const final = this.asr!.end().then((f) => timedOn(f, audio, lang));
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
    const vad = await MicVAD.new({
      model: vadCfg.model,
      // vad-web defaults to listening on load, which would unmute a muted mic on a device swap.
      startOnLoad: false,
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
      onSpeechEnd: (audio) => { void this.onSpeechEnd(audio, this.endStream(audio)); },
      onFrameProcessed: (p, frame) => this.onFrame(frame, p.isSpeech >= vadCfg.speechThreshold),
      onVADMisfire: () => { this.streaming = false; this.segmentLost(); if (this.phase === "listening") this.setPhase("idle"); },
    });
    // Stopped while the VAD loaded (a mic swap racing hang-up): nothing may keep listening.
    if (this.stopped) { void vad.destroy().catch(() => { /* */ }); return; }
    this.vad = vad;
    this.syncAsr();
    warmNativeEngines();
    clearInterval(this.keepWarm);
    this.keepWarm = setInterval(warmNativeEngines, KEEP_WARM_MS);
    // A device swap rebuilds the VAD through here, and a muted mic must stay muted.
    if (!this.muted || this.ptt) await vad.start();
    if (this.stopped) return;
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
    this.segmentLost();
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
    const speaking = this.phase === "speaking" || this.player.playing();
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
    const barge = !!this.tentative || (((thinking && !speaking) || (speaking && Date.now() - this.speakingStartAt > ONSET_GRACE_MS)) && echoSafe && !holding);
    if (barge && (this.tentative || (this.phase !== "listening" && !this.finalizing))) {
      // A cough or a "mm-hmm" must not end the reply: pause it now, and let the
      // words (the final, or talk past BACKCHANNEL_MAX_MS) decide.
      this.pauseReply();
    } else if (barge) {
      // Over the user's own sentence still being finalized: as before, cut at once.
      this.bargeIn();
    } else if (holding && echoSafe && speaking) {
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
    this.barged = barge;
    this.hearing = true;
    this.voicedMs = 0;
    this.clearHold();
    this.curBuf = []; this.curLen = 0; this.partialMs = 0;
    this.syncAsr();
    this.uttEngine = activeSttEngine();
    this.streaming = !!this.asr?.live;
    if (this.streaming) { this.asr!.reset(); this.asr!.send(this.ring.drain()); }
    this.setPhase("listening");
  }

  private onFrame(frame: Float32Array, speech: boolean) {
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
    if (this.tentative && this.hearing && speech && (this.voicedMs += frame.length / 16) > BACKCHANNEL_MAX_MS) this.bargeIn();
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
    // Over a paused reply only the final decides, so the engine is kept free for it.
    if ((this.uttEngine === "whisper" && !hasWebGPU()) || this.asr || this.partialBusy || this.finalizing || this.tentative) return;
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
      const { text } = await stt(win, abort.signal);
      // The browser's Whisper finishes an aborted caption anyway. Its segment has
      // ended, so the final decides: a half-heard laugh read as "have a" must not.
      if (text && !abort.signal.aborted && !isJunk(text) && this.phase === "listening") this.heardPartial(text);
    } catch { /* best-effort */ }
    finally { this.partialBusy = false; this.partialMs = Date.now() - now; if (this.partialAbort === abort) this.partialAbort = null; }
  }

  /** An interim transcript. Over a paused reply it decides nothing: Whisper reads
   *  half a laugh as "have a", and the reply is silent until the final is in. */
  private heardPartial(shown: string) {
    if (this.tentative) return;
    this.h.onPartial(shown);
  }

  // `final` is the streamed transcript of `audio` alone, when it was streamed.
  private async onSpeechEnd(audio: Float32Array, final?: Promise<Heard>) {
    if (this.echo) { this.echo = false; return; }
    this.hearing = false;
    // The agent runs one transcription at a time: a caption still queued there
    // would make the final wait for it.
    this.partialAbort?.abort();
    // A segment ended while the previous one is still finalizing (STT + turn detection
    // take real time on CPU/WASM). DON'T drop it — defer and re-process below, or the
    // user's words vanish.
    if (this.finalizing) { this.deferred.push({ audio, final }); return; }
    const combined = this.pending ? this.concat([this.pending, audio], this.pending.length + audio.length) : audio;
    if (this.tentative && (combined.length < MIN_UTTER_SAMPLES || rmsOf(audio) < this.gate())) { this.resumeReply(); return; }
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
      // Talking over the agent is saying something to act on now ("stop, just say
      // hello"), so it gets no mid-thought hold; the turn model would only wait it out.
      const barged = this.barged;
      // While push-to-talk is held, no end-of-turn decision at all: just accumulate
      // and caption — release (endPtt) is the one and only turn boundary.
      const useTurnModel = !this.ptt && !barged && turnModelReady() && turnCfg.engine !== "silence";
      // A streamed final covers this segment only; a held one is already transcribed.
      const held: Heard = this.pending ? { text: this.pendingText, at: this.pendingAt } : { text: "", at: [] };
      const transcript = final
        ? final.then((h) => joinHeard(held, combined.length - audio.length, h)).catch(() => stt(combined))
        : stt(combined);
      const [heard, modelComplete] = await Promise.all([
        transcript,
        useTurnModel ? turnComplete(combined, turnCfg.threshold) : Promise.resolve(true),
      ]);
      const text = heard.text.trim();
      if (this.stopped) return;
      if (this.tentative) {
        if (isJunk(text) || isBackchannel(text, loadPipelineConfig().language)) { this.resumeReply(); return; }
        this.bargeIn();
      }
      const sttEndpointMs = performance.now() - perf0;
      if (this.ptt) { this.pending = combined; this.pendingText = text; this.pendingAt = heard.at; if (!isJunk(text)) this.h.onPartial(text); this.setPhase("idle"); return; }
      // Drop empties and Whisper's silence-hallucinations so background noise and
      // dead air never fire a turn.
      if (isJunk(text)) { this.pending = null; this.h.onPartial(""); this.setPhase("idle"); return; }
      // Hold through a mid-thought pause (model says "not done", or the words
      // trail off) instead of cutting in — but never longer than the configured
      // hold / 20 s.
      const done = barged || !!this.h.answersAsk?.(text) || (modelComplete && !endsMidThought(text, loadPipelineConfig().language));
      if (!done && combined.length < 16000 * 20) {
        this.pending = combined;
        this.pendingText = text;
        this.pendingAt = heard.at;
        this.h.onPartial(text);
        this.scheduleHold();
        this.setPhase("idle");
        return;
      }
      this.pending = null;
      this.clearHold();
      this.setPhase("thinking");
      this.spokenText = ""; // new turn: clear the previous reply's spoken text
      this.voicing = null;
      this.replyFed = false;
      this.replyVoice = null;
      this.acceptingReply = true; // re-arm: this turn's reply should be voiced
      this.replyOpen = true;
      this.turnSentAt = performance.now();
      perf.turnCommitted(sttEndpointMs);
      this.h.onUserText(text, heard.at);
    } catch {
      // A stalled/failed inference (now time-limited in models.call) must not strand
      // the turn loop — recover to idle and clear the frozen partial caption.
      if (this.stopped) return;
      if (this.tentative) this.bargeIn(); // words unknown over a paused reply: talk always stops the agent
      this.pending = null; this.h.onPartial(""); this.setPhase("idle");
    } finally {
      this.finalizing = false;
      // Speech that arrived mid-finalize: merge it and process as a continuation
      // (onSpeechEnd folds in `pending`, so a mid-thought hold still coalesces).
      if (this.deferred.length) {
        const parts = this.deferred; this.deferred = [];
        const merged = this.concat(parts.map((p) => p.audio), parts.reduce((n, p) => n + p.audio.length, 0));
        let n = 0;
        const starts = parts.map((p) => (n += p.audio.length) - p.audio.length);
        const finals = parts.every((p) => p.final)
          ? Promise.all(parts.map((p) => p.final!)).then((hs) => hs.reduce((a, h, i) => joinHeard(a, starts[i]!, h), { text: "", at: [] }))
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
    // Kept, not sent: mid-segment onSpeechEnd folds it in, and over a spoken line it
    // waits for the engine to go idle.
    if (this.phase !== "idle") { if (this.pending && this.phase !== "listening") this.scheduleHold(); return; }
    const p = this.pending; const cached: Heard = { text: this.pendingText.trim(), at: this.pendingAt };
    this.pending = null; this.pendingText = "";
    this.clearHold();
    if (!p) return;
    const commit = (h: Heard) => {
      if (this.stopped) return;
      const text = h.text.trim();
      if (text && !isJunk(text)) { this.setPhase("thinking"); this.spokenText = ""; this.voicing = null; this.replyFed = false; this.replyVoice = null; this.acceptingReply = true; this.replyOpen = true; this.turnSentAt = performance.now(); perf.turnCommitted(0); this.h.onUserText(text, h.at); }
      else this.h.onPartial(""); // held fragment came back empty/junk → clear the caption
    };
    // The held audio was already transcribed in onSpeechEnd (that's how we knew it
    // was mid-thought), so reuse that transcript instead of re-running STT here —
    // the auto-send path was paying for a second transcription. Fall back to STT
    // only if for some reason we don't have the cached text.
    if (cached.text) commit(cached);
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
    if ((this.tentative || this.phase === "speaking" || this.phase === "thinking" || this.player.playing()) && !this.h.holdBargeIn?.()) this.bargeIn();
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
    if (this.stopped) return;
    this.ptt = false;
    if (this.muted) void this.vad?.pause(); // the hold is over — restore the mute
    const p = this.pending; const cached: Heard = { text: this.pendingText, at: this.pendingAt };
    this.pending = null;
    if (!p || p.length < MIN_UTTER_SAMPLES) { this.h.onPartial(""); if (this.phase === "listening") this.setPhase("idle"); return; }
    const perf0 = performance.now();
    try {
      // `pendingText` is always the transcript of exactly `pending`.
      const heard = cached.text ? cached : await stt(p);
      const text = heard.text.trim();
      if (this.stopped) return;
      if (isJunk(text)) { this.h.onPartial(""); this.setPhase("idle"); return; }
      this.setPhase("thinking");
      this.spokenText = "";
      this.voicing = null;
      this.replyFed = false;
      this.replyVoice = null;
      this.acceptingReply = true;
      this.replyOpen = true;
      this.turnSentAt = performance.now();
      perf.turnCommitted(this.turnSentAt - perf0);
      this.h.onUserText(text, heard.at);
    } catch { if (!this.stopped) { this.h.onPartial(""); this.setPhase("idle"); } }
  }
  pttActive() { return this.ptt; }

  // ── agent reply → speech ───────────────────────────────────────────────
  feedAgentDelta(text: string) {
    if (!this.acceptingReply) return; // interrupted reply's straggler deltas — don't voice them
    this.replyFed = true;
    this.replyOpen = true;
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
    this.replyOpen = false;
    // When the TTS chain drains and audio finishes, drop back to idle.
    const ep = this.epoch;
    void this.ttsChain.then(() => { if (this.epoch === ep && this.phase === "speaking") this.waitDrainThenIdle(ep); if (this.epoch === ep && this.phase === "thinking") this.setPhase("idle"); });
  }
  /** Once the voice goes quiet: idle after the reply, or thinking while it waits on
   *  an ask, which surfaces show as waiting for the user. */
  private waitDrainThenIdle(ep: number) {
    const check = () => {
      if (this.epoch !== ep || (this.replyOpen && !this.h.holdBargeIn?.())) return;
      if (this.player.playing()) { setTimeout(check, 120); return; }
      if (this.phase === "speaking") this.setPhase(this.replyOpen ? "thinking" : "idle");
    };
    check();
  }

  private enqueueSpeak(sentence: string, epoch: number, v: ReplyVoice, outOfBand = false) {
    if (this.stopped) return;
    this.ttsChain = this.ttsChain.then(async () => {
      if (this.epoch !== epoch) return; // barged-in → drop stale speech
      // The caption shows `spoken`, as the model wrote it; the voice says `said`.
      const spoken = stripMarkdown(sentence);
      if (!spoken) return;
      const { said, from } = normalizeAligned(spoken, v.lang, v.lexicon);
      const abort = new AbortController();
      this.ttsAbort = abort;
      // Each word's onset: paced by an estimate, then placed on each piece's
      // audio once all of it is in (timing.ts).
      const words = spokenWords(spoken, said, from);
      const estimate = (i: number) => estimateSpeechMs(said.slice(i), v.family, v.speed, v.lang);
      let at = paceWords(words, estimate(0)), shownAs = 0;
      // A streaming engine hands over the sentence in pieces; the chain still waits
      // for all of them, so sentences play in order while the next one synthesizes
      // under the current one's playback.
      let samples = 0, rate = 24000, first = true, end = 0;
      try {
        for (const piece of speechPieces(said, v.lang)) {
          if (this.epoch !== epoch || abort.signal.aborted) break;
          const start = said.indexOf(piece, end), heard: Float32Array[] = [], before = samples;
          end = start + piece.length;
          await ttsStream(piece, { engine: v.engine, voice: v.voice, speed: v.speed, lang: v.lang }, (audio, sampleRate) => {
            if (this.epoch !== epoch) return;
            samples += audio.length; rate = sampleRate;
            heard.push(audio);
            // Over the user's sentence the phase stays listening, which is what keeps
            // gathering their words; setPhase hands it over when the sentence ends.
            if (this.phase !== "speaking" && this.phase !== "listening") {
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
              const onsets = captionOnsets(spoken, words, at);
              this.voicing = { before: this.spokenText, text: spoken, at: onsets, t0: performance.now(), lag: 0 };
              this.spokenText += (this.spokenText ? " " : "") + spoken;
              shownAs = ++this.captionSeq;
              this.h.onAgentText(spoken, onsets);
            } : undefined;
            first = false;
            this.player.play(audio, epoch, sampleRate, onStart);
          }, abort.signal);
          if (this.epoch !== epoch || !heard.length) continue;
          const i0 = words.filter((w) => w.start < start).length, i1 = words.filter((w) => w.start < end).length;
          const pcm = new Float32Array(samples - before);
          heard.reduce((o, a) => (pcm.set(a, o), o + a.length), 0);
          at = [
            ...at.slice(0, i0),
            ...placeWords(words.slice(i0, i1), pcm, rate).map((t) => t + (before / rate) * 1000),
            ...paceWords(words.slice(i1), estimate(end)).map((t) => t + (samples / rate) * 1000),
          ];
          if (shownAs && shownAs === this.captionSeq) {
            const onsets = captionOnsets(spoken, words, at);
            if (this.voicing) { this.voicing.at = onsets; this.h.onAgentTiming?.(this.shownAt(this.voicing)); }
          }
        }
        // No voice speaks the language: the words still reach the caption and transcript.
        if (first && !outOfBand && this.epoch === epoch && !abort.signal.aborted) {
          this.voicing = null;
          this.spokenText += (this.spokenText ? " " : "") + spoken;
          this.h.onAgentText(spoken, captionOnsets(spoken, words, at));
        }
      } finally {
        if (this.ttsAbort === abort) this.ttsAbort = null;
      }
    }).catch((e) => { log.warn("live", "TTS failed:", e?.message ?? e); });
    // An ask's question: once it is voiced, the reply waits on the user.
    if (this.replyOpen && this.h.holdBargeIn?.()) void this.ttsChain.then(() => this.waitDrainThenIdle(epoch));
  }

  /** Speak a short out-of-band line (e.g. an agent failure) through the same
   *  TTS chain — voice-first users hear problems, not just see banners. */
  say(text: string) {
    const t = text.trim();
    if (!t) return;
    // In the reply's voice when it lands mid-reply.
    this.enqueueSpeak(t, this.epoch, this.replyVoice ?? voiceNow(), true /* out-of-band: voice it, don't persist it */);
    // Outside a reply no endAgentTurn follows to end the "speaking" this line starts.
    if (!this.replyOpen) { const ep = this.epoch; void this.ttsChain.then(() => this.waitDrainThenIdle(ep)); }
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
    // A paused reply is now cut: the surface still shows the phase it paused in.
    if (this.tentative) { this.tentative = null; this.h.onPhase(this.phase); }
  }

  private pauseReply() {
    if (this.tentative) return;
    this.tentative = this.phase;
    this.pausedAt = performance.now();
    this.player.hold();
    if (this.voicing) this.h.onAgentTiming?.(this.shownAt(this.voicing)); // the caption waits with the voice
  }

  /** Nothing in the paused-over sound asked the agent to stop: go on from the
   *  same sample, in the same phase, the segment dropped. A later segment still
   *  being heard or transcribed decides instead. */
  private resumeReply() {
    if (this.hearing || this.deferred.length) return;
    const shown = this.tentative!;
    this.tentative = null;
    this.phase = shown; // never reported as listening
    if (this.voicing) { this.voicing.lag += performance.now() - this.pausedAt; this.h.onAgentTiming?.(this.shownAt(this.voicing)); }
    this.player.release();
    const playing = this.player.playing();
    if (playing) this.speakingStartAt = Date.now(); // its first syllable back is echo, as at the reply's start
    this.setPhase(playing ? "speaking" : this.replyOpen ? shown : "idle");
    if (playing && !this.replyOpen) this.waitDrainThenIdle(this.epoch);
  }

  /** The segment ended without a verdict (a misfire, a mute, a new mic). */
  private segmentLost() {
    this.hearing = false;
    if (this.tentative && !this.finalizing) this.resumeReply();
  }

  /** `v.at` as voiced: shifted by its pauses, and while paused, the words not yet
   *  heard held off (Infinity) so the caption does not run on without the voice. */
  private shownAt(v: NonNullable<VoiceEngine["voicing"]>): number[] {
    const heard = this.tentative ? this.pausedAt - v.t0 - v.lag : Infinity;
    return v.at.map((t) => (t <= heard ? t + v.lag : Infinity));
  }

  private bargeIn() {
    this.h.onBargeIn(this.cutReply());
  }

  /** Silence the reply and drop the rest of it, returning what was actually
   *  voiced. Barge-in, a Stop button and hanging up are the same cut. */
  cutReply(): string | undefined {
    const spoken = this.spokenSoFar();
    this.acceptingReply = false; // ignore the interrupted reply's remaining deltas until the next turn
    this.replyOpen = false;
    this.hush();
    return this.replyFed ? spoken : undefined;
  }

  /** The reply as voiced by now: whole sentences, then the words of the playing
   *  one begun by now, as its caption reveals them. O(length of that sentence). */
  private spokenSoFar(): string {
    const v = this.voicing;
    if (!v) return this.spokenText.trim();
    const heard = heardText(v.text, this.shownAt(v), performance.now() - v.t0);
    return (v.before ? `${v.before} ${heard}` : heard).trim();
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
  private setPhase(p: EnginePhase) {
    // A line that began over the user's sentence takes over when the sentence ends;
    // its reply's end, or its own, found the phase on listening and idled nothing.
    const handover = p === "idle" && this.phase === "listening" && this.player.playing();
    if (handover) p = "speaking";
    if (p !== this.phase) { this.phase = p; if (!this.tentative) this.h.onPhase(p); }
    if (handover && !this.replyOpen) this.waitDrainThenIdle(this.epoch);
  }

  /** Mute (manual / hands-free toggle): pause listening; a held pending is dropped. */
  setMuted(muted: boolean) {
    this.muted = muted;
    if (!this.vad) return;
    if (muted) { this.clearHold(); this.pending = null; this.streaming = false; this.segmentLost(); this.ring.clear(); this.micRms = 0; void this.vad.pause(); if (this.phase === "listening") this.setPhase("idle"); }
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
    this.stopped = true;
    this.deferred = [];
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
