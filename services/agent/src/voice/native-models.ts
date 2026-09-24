import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { extract } from "tar";
import unbzip2 from "unbzip2-stream";
import { DATA_DIR } from "@openlive/db";

// Native speech engines the user can pick in place of the in-browser models.
// Each is a prebuilt sherpa-onnx archive, downloaded on demand into
// DATA_DIR/models/<id>. Asset names and sizes verified 2026-09-24 against the
// k2-fsa/sherpa-onnx `asr-models` and `tts-models` release assets.

export type EngineKind = "asr" | "tts";
export interface EngineVoice { id: string; name: string; gender?: "female" | "male"; sid?: number; wav?: string }
export interface NativeEngine {
  id: string;
  kind: EngineKind;
  name: string;
  url: string;
  sizeBytes: number; // archive bytes, the download progress total
  files: string[]; // relative to the engine dir; all present = installed
  streaming?: boolean;
  voices?: EngineVoice[];
}

const RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

export const NATIVE_ENGINES: NativeEngine[] = [
  {
    id: "nemotron", kind: "asr", name: "Nemotron Streaming 0.6B", streaming: true,
    url: `${RELEASES}/asr-models/sherpa-onnx-nemotron-speech-streaming-en-0.6b-160ms-int8-2026-04-25.tar.bz2`,
    sizeBytes: 463_945_198,
    files: ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
  },
  {
    id: "parakeet", kind: "asr", name: "Parakeet TDT 0.6B v2",
    url: `${RELEASES}/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2`,
    sizeBytes: 482_468_385,
    files: ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
  },
  {
    id: "moonshine", kind: "asr", name: "Moonshine Base",
    url: `${RELEASES}/asr-models/sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2`,
    sizeBytes: 111_266_225,
    files: ["encoder_model.ort", "decoder_model_merged.ort", "tokens.txt"],
  },
  {
    // Clones the voice of a reference clip on every call; the archive ships three.
    id: "pocket", kind: "tts", name: "Pocket TTS",
    url: `${RELEASES}/tts-models/sherpa-onnx-pocket-tts-int8-2026-01-26.tar.bz2`,
    sizeBytes: 98_336_520,
    files: ["lm_flow.int8.onnx", "lm_main.int8.onnx", "encoder.onnx", "decoder.int8.onnx", "text_conditioner.onnx", "vocab.json", "token_scores.json",
      "test_wavs/bria.wav", "test_wavs/loona.wav", "test_wavs/sample_fr_hibiki_crepes.wav"],
    voices: [
      { id: "bria", name: "Bria", wav: "test_wavs/bria.wav" },
      { id: "loona", name: "Loona", wav: "test_wavs/loona.wav" },
      { id: "hibiki", name: "Hibiki", wav: "test_wavs/sample_fr_hibiki_crepes.wav" },
    ],
  },
  {
    // Speaker ids follow voices.bin row order (sherpa-onnx scripts/kitten-tts/v0_8);
    // names are KittenML's voice_aliases for those rows.
    id: "kitten", kind: "tts", name: "Kitten TTS Nano",
    url: `${RELEASES}/tts-models/kitten-nano-en-v0_8-int8.tar.bz2`,
    sizeBytes: 31_220_690,
    files: ["model.int8.onnx", "voices.bin", "tokens.txt", "espeak-ng-data/phontab"],
    voices: [
      { id: "jasper", name: "Jasper", gender: "male", sid: 0 },
      { id: "bella", name: "Bella", gender: "female", sid: 1 },
      { id: "bruno", name: "Bruno", gender: "male", sid: 2 },
      { id: "luna", name: "Luna", gender: "female", sid: 3 },
      { id: "hugo", name: "Hugo", gender: "male", sid: 4 },
      { id: "rosie", name: "Rosie", gender: "female", sid: 5 },
      { id: "leo", name: "Leo", gender: "male", sid: 6 },
      { id: "kiki", name: "Kiki", gender: "female", sid: 7 },
    ],
  },
];

/** Text as the native voices should get it. Measured 2026-09-24: kitten
 *  (espeak-ng) reads emoji and code symbols out by name ("party popper"), and
 *  pocket runs on for 10-45 s far more often on a line like "if (x != null) { y++ }". */
export const speakable = (text: string) => text
  .replace(/\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}‍️⃣]/gu, " ")
  .replace(/[<>!=]=+|=>|[{}[\]<>|\\^~`_*]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const byId = new Map(NATIVE_ENGINES.map((e) => [e.id, e]));
export const nativeEngine = (id: string | undefined): NativeEngine | undefined => (id ? byId.get(id) : undefined);

export const engineDir = (id: string) => resolve(DATA_DIR, "models", id);

export const engineInstalled = (e: NativeEngine) => e.files.every((f) => existsSync(join(engineDir(e.id), f)));

/** O(files under the dir). */
export function engineDiskBytes(id: string): number {
  let total = 0;
  const walk = (dir: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else { try { total += statSync(p).size; } catch { /* racing a delete */ } }
    }
  };
  try { walk(engineDir(id)); } catch { /* not installed */ }
  return total;
}

/** Stream the archive into <id>.part and rename it into place only once every
 *  expected file is there, so a failed, aborted, or killed download never
 *  leaves a half-installed engine (a stale .part is wiped by the next try). */
export async function downloadEngine(e: NativeEngine, onBytes: (n: number) => void, signal: AbortSignal): Promise<void> {
  const dir = engineDir(e.id);
  const part = `${dir}.part`;
  rmSync(part, { recursive: true, force: true });
  mkdirSync(part, { recursive: true });
  try {
    const res = await fetch(e.url, { redirect: "follow", signal });
    if (!res.ok || !res.body) throw new Error(`download HTTP ${res.status}`);
    const counted = new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, ctrl) { onBytes(chunk.byteLength); ctrl.enqueue(chunk); } });
    await pipeline(Readable.fromWeb(res.body.pipeThrough(counted) as never), unbzip2(), extract({ cwd: part, strip: 1 }), { signal });
    const missing = e.files.filter((f) => !existsSync(join(part, f)));
    if (missing.length) throw new Error(`archive is missing ${missing.join(", ")}`);
    rmSync(dir, { recursive: true, force: true });
    renameSync(part, dir);
  } catch (err) {
    rmSync(part, { recursive: true, force: true });
    throw err;
  }
}
