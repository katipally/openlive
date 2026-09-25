// Gap-free playback of the agent's 24 kHz PCM by scheduling each buffer on a
// running clock. Barge-in = flush(epoch): stop everything scheduled and ignore
// any audio tagged below the new epoch (kills the ~1s already-buffered tail).
//
// CRITICAL for barge-in on speakers: we do NOT play to AudioContext.destination.
// Chrome's echo canceller (AEC3) is blind to Web-Audio output, so the agent's
// voice would leak into the mic uncancelled and break barge-in. Instead we route
// through a MediaStreamDestination into a hidden <audio> element — which AEC3
// DOES reference — so the agent's own voice is cancelled from the mic input.
import { octaveBands } from "./spectrum";

export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private sink: MediaStreamAudioDestinationNode | null = null;
  private el: HTMLAudioElement | null = null;
  private analyser: AnalyserNode | null = null;   // taps the output for LIVE amplitude
  private tap: Float32Array | null = null;         // reusable time-domain buffer
  private freq: Uint8Array | null = null;          // reusable frequency buffer (spectrum)
  private nextAt = 0;
  private minEpoch = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private timers = new Set<ReturnType<typeof setTimeout>>(); // pending onStart callbacks
  private rms = 0;

  private ensure(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.sink = this.ctx.createMediaStreamDestination();
      // A parallel analyser tap so level() reflects the REAL, moment-to-moment
      // voice amplitude (drives a lively orb) instead of a static per-chunk RMS.
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.6; // steadier spectrum bars
      this.tap = new Float32Array(this.analyser.fftSize);
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      const el = document.createElement("audio");
      el.autoplay = true;
      el.setAttribute("playsinline", "");
      el.srcObject = this.sink.stream; // <audio> playback → AEC references it
      el.style.display = "none";
      document.body.appendChild(el);
      void el.play().catch(() => {});
      this.el = el;
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  // TTS hands us Float32 (24 kHz from Kokoro and the native engines), whole or
  // as streamed pieces that queue back to back. `onStart` fires
  // when THIS chunk actually begins playing (not when it was synthesized) — so a
  // caption can track the voice instead of racing ahead of it.
  play(f32: Float32Array, epoch: number, sampleRate = 24000, onStart?: () => void) {
    if (epoch < this.minEpoch || f32.length === 0) return;
    const ctx = this.ensure();
    let sum = 0;
    for (let i = 0; i < f32.length; i++) { const v = f32[i]!; sum += v * v; }
    this.rms = Math.sqrt(sum / f32.length);
    const buf = ctx.createBuffer(1, f32.length, sampleRate);
    buf.getChannelData(0).set(f32); // avoids the Float32Array<ArrayBufferLike> generic mismatch
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.sink!); // → MediaStreamDestination → <audio> (AEC-visible)
    if (this.analyser) src.connect(this.analyser); // parallel tap (no audio output)
    const startAt = Math.max(ctx.currentTime + 0.02, this.nextAt);
    src.start(startAt);
    this.nextAt = startAt + buf.duration;
    this.sources.add(src);
    src.onended = () => { this.sources.delete(src); if (this.sources.size === 0) this.rms = 0; };
    if (onStart) {
      const t = setTimeout(() => { this.timers.delete(t); onStart(); }, Math.max(0, (startAt - ctx.currentTime) * 1000));
      this.timers.add(t);
    }
  }

  flush(epoch: number) {
    this.minEpoch = epoch;
    for (const s of this.sources) { try { s.stop(); } catch { /* already stopped */ } }
    this.sources.clear();
    for (const t of this.timers) clearTimeout(t); // drop pending caption updates
    this.timers.clear();
    this.nextAt = 0;
    this.rms = 0;
  }

  // Live output amplitude from the analyser tap (0..~1) while audio plays — a
  // moving value so the orb pulses with the voice. Falls back to the last chunk's
  // static RMS if the analyser isn't available or nothing is scheduled.
  level() {
    if (this.analyser && this.tap && this.sources.size > 0) {
      this.analyser.getFloatTimeDomainData(this.tap as Float32Array<ArrayBuffer>);
      let sum = 0; for (let i = 0; i < this.tap.length; i++) sum += this.tap[i]! * this.tap[i]!;
      return Math.sqrt(sum / this.tap.length);
    }
    return this.sources.size > 0 ? this.rms : 0;
  }
  /** N octave-band magnitudes (0..1) of the agent's voice — a real spectrum for the
   *  orb while it speaks. Zeros when nothing is playing. */
  agentBands(n = 5): number[] {
    if (!this.analyser || !this.freq || this.sources.size === 0) return new Array(n).fill(0);
    this.analyser.getByteFrequencyData(this.freq as Uint8Array<ArrayBuffer>);
    return octaveBands(this.freq, n);
  }
  playing() { return this.sources.size > 0; }
  resume() { this.ensure(); }
  close() {
    this.flush(Number.MAX_SAFE_INTEGER);
    try { this.el?.pause(); this.el?.remove(); } catch { /* */ }
    try { void this.ctx?.close(); } catch { /* */ }
    this.el = null; this.sink = null; this.ctx = null; this.analyser = null; this.tap = null;
  }
}
