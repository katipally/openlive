import { Silero, type Model } from "@ricky0123/vad-web/dist/models";
import { ort } from "@ricky0123/vad-web/dist/real-time-vad";
import type { VadModel } from "./pipelineConfig";

// A hold's tape runs from the moment the microphone opens, so it is checked for
// speech before it is transcribed: from room sound alone a speech model writes
// "Thanks!" or "The End". It runs on the VAD's own Silero weights, in a session
// of its own, since the live VAD's model keeps state from frame to frame.

/** Silero v5 and v6 read 512 samples a frame, 32 ms at 16 kHz. */
const FRAME = 512;
// Measured 2026-10-02 (tapeSpeech.test.ts keeps three of the words as fixtures):
// "yes", "no", "ok", "hi" and "thanks" in five macOS voices, said at -40 to -26
// dBFS over a -60 to -40 dBFS room, ran 6 to 22 frames in a row at the default
// 0.5 on v6 (7 or more on v5). Only words too soft for the old loudness rule
// (-46 dBFS, the whole tape under RMS_GATE) ran fewer, 2 or 3. Pink, white and
// brown noise, 60 Hz hum and key clicks at -50 to -20 dBFS never scored even 0.35
// in a frame. Three frames (96 ms) is half the shortest word, and a third of the
// live VAD's 250 ms minimum, which is why the tape is kept at all.
export const MIN_SPEECH_FRAMES = 3;
// The first speech frame came up to 208 ms after the word's sound began, so the
// transcription starts this long before it.
export const PRE_ROLL_MS = 300;

/**
 * Where to start transcribing `audio`: PRE_ROLL_MS before its first run of
 * MIN_SPEECH_FRAMES frames that `speech` scores at `threshold` or over, or -1
 * when it has none. It stops at that run, so it costs O(frames before it):
 * the whole tape only when there is no speech (about 0.3 s a minute on WASM).
 */
export async function speechFrom(audio: Float32Array, speech: (frame: Float32Array) => Promise<number>, threshold: number): Promise<number> {
  let run = 0;
  for (let at = 0; at + FRAME <= audio.length; at += FRAME) {
    run = (await speech(audio.subarray(at, at + FRAME))) >= threshold ? run + 1 : 0;
    if (run === MIN_SPEECH_FRAMES) return Math.max(0, at - (MIN_SPEECH_FRAMES - 1) * FRAME - PRE_ROLL_MS * 16);
  }
  return -1;
}

const loaded = new Map<VadModel, Promise<Model>>();
/** The VAD's weights for the tape, loaded once a page; `/vad/` is where MicVAD finds them. */
export function tapeVad(model: VadModel): Promise<Model> {
  let m = loaded.get(model);
  if (!m) {
    ort.env.wasm.wasmPaths = "/vad/";
    m = Silero.new(ort, () => fetch(`/vad/silero_vad_${model}.onnx`).then((r) => r.arrayBuffer()));
    m.catch(() => loaded.delete(model));
    loaded.set(model, m);
  }
  return m;
}
