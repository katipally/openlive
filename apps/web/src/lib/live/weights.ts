// The weights the in-browser model workers fetch from the Hugging Face hub,
// which of them are not in the browser cache yet, and what fetching those
// costs, read from the hub's own file listing. Nothing here downloads a model:
// it is what the user is shown before agreeing to.
import { whisperCheckpoint, isNativeVariant, type PipelineConfig } from "./pipelineConfig";

export type ModelKey = "stt" | "tts" | "turn";
export type Tier = "webgpu" | "wasm";

const HF = "https://huggingface.co";
export const KOKORO_REPO = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const SUPERTONIC_REPO = "Supertone/supertonic-3";
export const SMART_TURN = { repo: "pipecat-ai/smart-turn-v3", path: "smart-turn-v3.2-cpu.onnx" };
const SUPERTONIC_PARTS = ["duration_predictor", "text_encoder", "vector_estimator", "vocoder"];

/** Where transformers.js and our own loaders fetch, and cache, a hub file. */
export const hubUrl = (repo: string, path: string) => `${HF}/${repo}/resolve/main/${path}`;

export interface WeightFile { key: ModelKey; repo: string; path: string }

/** Whisper checkpoint `repo`'s weights on `tier`. The dtype suffixes are the
 *  ones models.worker.ts asks transformers.js for. Pure. */
export function whisperWeights(repo: string, tier: Tier): WeightFile[] {
  const [enc, dec] = repo.endsWith("large-v3-turbo") ? ["_fp16", "_q4"] : tier === "webgpu" ? ["", ""] : ["_quantized", "_quantized"];
  return [{ key: "stt", repo, path: `onnx/encoder_model${enc}.onnx` }, { key: "stt", repo, path: `onnx/decoder_model_merged${dec}.onnx` }];
}

/** Browser voice `engine`'s weights on `tier`: Supertonic, or Kokoro for any
 *  other, as the worker reads it. Pure. */
export const voiceWeights = (engine: string, tier: Tier): WeightFile[] =>
  engine === "supertonic"
    ? SUPERTONIC_PARTS.map((p) => ({ key: "tts" as const, repo: SUPERTONIC_REPO, path: `onnx/${p}.onnx` }))
    : [{ key: "tts", repo: KOKORO_REPO, path: `onnx/model${tier === "webgpu" ? "" : "_quantized"}.onnx` }];

export const TURN_WEIGHTS: WeightFile[] = [{ key: "turn", ...SMART_TURN }];

/**
 * The model files the worker loads for `c` on `tier`, `browserTts` being the
 * browser voice it loads (null for none). Only the weights: the config and
 * tokenizer files beside them are a few kilobytes. Pure.
 */
export function weightFiles(c: PipelineConfig, tier: Tier, browserTts: string | null): WeightFile[] {
  return [
    ...(isNativeVariant(c.stt.variant) ? [] : whisperWeights(whisperCheckpoint(c.stt.whisperSize, c.language, tier), tier)),
    ...(browserTts ? voiceWeights(browserTts, tier) : []),
    ...TURN_WEIGHTS,
  ];
}

/** The files of `files` the browser cache does not hold, from a page or a
 *  worker alike. Without a Cache API
 *  nothing is kept, so everything is. O(files). */
export async function missingWeights(files: WeightFile[]): Promise<WeightFile[]> {
  if (typeof caches === "undefined") return files;
  const held = await Promise.all(files.map((f) => caches.match(hubUrl(f.repo, f.path)).then(Boolean, () => false)));
  return files.filter((_, i) => !held[i]);
}

/** The files of `files` that would download, missing from the cache, and are
 *  not in `allow`: the hub URLs the person agreed to fetch. O(files). */
export async function unagreed(files: WeightFile[], allow: ReadonlySet<string>): Promise<WeightFile[]> {
  return (await missingWeights(files)).filter((f) => !allow.has(hubUrl(f.repo, f.path)));
}

/** A load that would have downloaded weights nobody agreed to: `missing` is
 *  what it would have fetched, for the offer that asks. */
export class ModelsNotDownloaded extends Error {
  constructor(readonly missing: WeightFile[] = []) { super("The voice models are not downloaded yet."); this.name = "ModelsNotDownloaded"; }
}

/** Downloads nothing unless every missing file of `files` is in `allow`. */
export async function refuseUnagreed(files: WeightFile[], allow: ReadonlySet<string>): Promise<void> {
  const missing = await unagreed(files, allow);
  if (missing.length) throw new ModelsNotDownloaded(missing);
}

// One listing per repo folder for the session; a failed one is asked again.
const listings = new Map<string, Promise<Map<string, number>>>();
function sizeOf(f: WeightFile): Promise<number> {
  const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
  const key = `${f.repo}/${dir}`;
  let listing = listings.get(key);
  if (!listing) {
    listing = fetch(`${HF}/api/models/${f.repo}/tree/main${dir && `/${dir}`}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<{ path: string; size: number; lfs?: { size: number } }[]>; })
      .then((xs) => new Map(xs.map((x) => [x.path, x.lfs?.size ?? x.size])));
    listing.catch(() => listings.delete(key));
    listings.set(key, listing);
  }
  return listing.then((m) => {
    const size = m.get(f.path);
    if (size === undefined) throw new Error(`${f.path} is not in ${f.repo}`);
    return size;
  });
}

/** What is left to download: `bytes` is null when the hub's listing could not be read. */
export interface DownloadPlan { missing: WeightFile[]; bytes: number | null }

/** The missing files of `files` and their total size. O(files), one listing request per repo folder. */
export async function downloadPlan(files: WeightFile[]): Promise<DownloadPlan> {
  const missing = await missingWeights(files);
  if (!missing.length) return { missing, bytes: 0 };
  try { return { missing, bytes: (await Promise.all(missing.map(sizeOf))).reduce((a, b) => a + b, 0) }; }
  catch { return { missing, bytes: null }; }
}

const MODEL_WORDS: Record<ModelKey, string> = { stt: "speech recognition", tts: "voice", turn: "turn-taking" };
/** The models a plan downloads, in the words the UI uses. */
export const planModels = (p: DownloadPlan): string[] => [...new Set(p.missing.map((f) => MODEL_WORDS[f.key]))];

/** "about 210 MB", "about 1.6 GB"; null for an unknown size. Decimal units, as the engine lists use. */
export function aboutSize(bytes: number | null): string | null {
  if (bytes === null) return null;
  return bytes >= 1e9 ? `about ${(bytes / 1e9).toFixed(1)} GB` : `about ${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** "a", "a and b", "a, b and c". */
export const listed = (xs: string[]): string => xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : xs[0] ?? "";

/** Where the weights live, said wherever the download is offered. */
export const WEIGHTS_WHERE = "They are kept in OpenLive's storage on this device and run fully offline after. Remove them any time in Settings > Speech engine.";
