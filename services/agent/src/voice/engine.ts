import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { DATA_DIR } from "@openlive/db";
import { log } from "../log.js";

// Zero-shot voice cloning on the agent service's CPU: ZipVoice (k2-fsa,
// Apache-2.0, 123M distilled int8) through the sherpa-onnx Node addon.
// Verified on this stack 2026-07-16: engine loads in ~0.7s, synthesizes at
// ~0.22× realtime on CPU, and the reference voice rides EVERY generate() call
// — so one engine instance serves every saved profile. generateAsync runs on
// the native thread pool, so live sessions never block.
//
// The models are an optional user-managed download (see routes.ts): ~160 MB
// down, ~208 MB on disk, deletable from Settings.

export const VOICE_MODEL_DIR = resolve(DATA_DIR, "models", "zipvoice");
export const VOICE_PROFILE_DIR = resolve(DATA_DIR, "voices");

const MODEL_FILES = ["tokens.txt", "encoder.int8.onnx", "decoder.int8.onnx", "lexicon.txt", "vocos_24khz.onnx"];
const IDLE_UNLOAD_MS = 5 * 60_000; // the loaded engine holds ~700 MB — free it when idle

export function modelInstalled(): boolean {
  return MODEL_FILES.every((f) => existsSync(join(VOICE_MODEL_DIR, f))) && existsSync(join(VOICE_MODEL_DIR, "espeak-ng-data"));
}

export function modelDiskBytes(): number {
  let total = 0;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else { try { total += statSync(p).size; } catch { /* racing a delete */ } }
    }
  };
  try { walk(VOICE_MODEL_DIR); } catch { /* not installed */ }
  return total;
}

// sherpa-onnx-node is a native addon — loaded lazily (never a static import) so
// the agent bundles and boots fine on machines that never touch cloning.
type Sherpa = {
  OfflineTts: new (cfg: unknown) => {
    generateAsync(req: unknown): Promise<{ samples: Float32Array; sampleRate: number }>;
    sampleRate: number;
  };
  GenerationConfig: new (o: Record<string, unknown>) => unknown;
  readWave: (path: string) => { samples: Float32Array; sampleRate: number };
};
let sherpa: Sherpa | null = null;
let engine: InstanceType<Sherpa["OfflineTts"]> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let queue: Promise<unknown> = Promise.resolve(); // serialize synth calls on one handle

function loadEngine(): InstanceType<Sherpa["OfflineTts"]> {
  if (engine) return engine;
  if (!modelInstalled()) throw new Error("voice model not installed");
  sherpa ??= createRequire(import.meta.url)("sherpa-onnx-node") as Sherpa;
  const t = Date.now();
  engine = new sherpa.OfflineTts({
    model: {
      zipvoice: {
        tokens: join(VOICE_MODEL_DIR, "tokens.txt"),
        encoder: join(VOICE_MODEL_DIR, "encoder.int8.onnx"),
        decoder: join(VOICE_MODEL_DIR, "decoder.int8.onnx"),
        vocoder: join(VOICE_MODEL_DIR, "vocos_24khz.onnx"),
        dataDir: join(VOICE_MODEL_DIR, "espeak-ng-data"),
        lexicon: join(VOICE_MODEL_DIR, "lexicon.txt"),
      },
      numThreads: 4,
    },
    maxNumSentences: 1,
  });
  log.debug("voice", `zipvoice engine loaded in ${Date.now() - t}ms`);
  return engine;
}

export function unloadEngine(): void {
  engine = null; // the addon frees on GC; dropping the handle is enough
  clearTimeout(idleTimer);
}

const armIdleUnload = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(unloadEngine, IDLE_UNLOAD_MS);
  idleTimer.unref?.();
};

export interface VoiceRef { wavPath: string; transcript: string }

/** Speak `text` in the reference voice. Serialized on one engine handle;
 *  synthesis itself runs on sherpa's native thread pool. */
export function synthesize(text: string, ref: VoiceRef, speed = 1): Promise<{ samples: Float32Array; sampleRate: number }> {
  const run = queue.then(async () => {
    const tts = loadEngine();
    const wave = sherpa!.readWave(ref.wavPath);
    // The lexicon drops OOV punctuation (em dash etc.) with a warning — strip it.
    const clean = text.replace(/[—–]/g, ", ").trim();
    const audio = await tts.generateAsync({
      text: clean,
      generationConfig: new sherpa!.GenerationConfig({
        speed,
        referenceAudio: wave.samples,
        referenceSampleRate: wave.sampleRate,
        referenceText: ref.transcript,
        numSteps: 4, // distilled model's intended step count
      }),
    });
    armIdleUnload();
    return audio;
  });
  queue = run.catch(() => {}); // a failed synth must not wedge the queue
  return run;
}
