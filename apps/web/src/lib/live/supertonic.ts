/// <reference lib="webworker" />
// Supertonic TTS (Supertone) on onnxruntime-web — the fast on-device engine next
// to Kokoro. Four small ONNX models (duration predictor, text encoder, flow
// vector estimator, vocoder ≈ 66M params total) + a unicode indexer; no G2P and
// no tokenizer download. 44.1 kHz output. Adapted from the MIT-licensed reference
// implementation (github.com/supertone-inc/supertonic web example), with the
// nested-array latents flattened to Float32Arrays. Model license: OpenRAIL-M.
// Runs inside models.worker.ts and shares its onnxruntime-web module instance.
import * as ort from "onnxruntime-web";

const HF = "https://huggingface.co/Supertone/supertonic-3/resolve/main";
export const SUPERTONIC_SAMPLE_HINT = 44100; // real rate comes from tts.json

// ponytail: 8 denoising steps = the reference default; lower if first-audio
// latency measures worse than Kokoro on target machines.
const STEPS = 8;

type Progress = (p: { file: string; loaded: number; total: number }) => void;

/** Fetch through the Cache API with byte progress (big .onnx files download once). */
async function cachedFetch(url: string, onProgress?: Progress): Promise<ArrayBuffer> {
  const file = url.split("/").pop()!;
  try {
    const cache = await caches.open("openlive-models-v1");
    const hit = await cache.match(url);
    if (hit) {
      const buf = await hit.arrayBuffer();
      onProgress?.({ file, loaded: buf.byteLength, total: buf.byteLength });
      return buf;
    }
  } catch { /* Cache API unavailable → plain fetch below */ }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  // Stream so the pre-call progress bar moves; assemble then cache.
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = await res.arrayBuffer();
    onProgress?.({ file, loaded: buf.byteLength, total: buf.byteLength });
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.({ file, loaded, total: total || loaded });
  }
  const buf = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  try { const cache = await caches.open("openlive-models-v1"); await cache.put(url, new Response(buf.slice().buffer)); } catch { /* best-effort */ }
  return buf.buffer;
}

// ── text preprocessing (reference UnicodeProcessor, web/helper.js) ───────────
// The language rides as a tag around the text, one of the model's 31 codes
// (huggingface.co/Supertone/supertonic-3). NFKD splits Hangul into jamo, as the
// reference does: the unicode indexer holds the jamo, not the syllables.
function preprocess(text: string, lang: string): string {
  // English words: in another language they would be read out as English.
  if (lang === "en") text = text.replaceAll("@", " at ").replaceAll("e.g.,", "for example, ").replaceAll("i.e.,", "that is, ");
  text = text.normalize("NFKD")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu, "")
    .replace(/[–‑—]/g, "-").replace(/_/g, " ")
    .replace(/[“”]/g, '"').replace(/[‘’´`]/g, "'")
    .replace(/[[\]|/#→←]/g, " ")
    .replace(/[♥☆♡©\\]/g, "")
    .replace(/ ([,.!?;:'])/g, "$1")
    .replace(/""+/g, '"').replace(/''+/g, "'")
    .replace(/\s+/g, " ").trim();
  if (!/[.!?;:,'")\]}…。」』】〉》›»]$/.test(text)) text += ".";
  return `<${lang}>${text}</${lang}>`;
}

// The initial latent is the only randomness in synthesis. Drawn fresh for every
// sentence, one voice came out a little different each time; seeded by the
// voice, every sentence starts from the same draw. FNV-1a seeds mulberry32,
// Box-Muller makes it Gaussian.
function seededNormal(seed: string): () => number {
  let a = [...seed].reduce((h, c) => Math.imul(h ^ c.codePointAt(0)!, 16777619), 2166136261);
  const uniform = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(Math.max(0.0001, uniform()))) * Math.cos(2 * Math.PI * uniform());
}

// Every render carries ~0.4 s of silence before the speech and ~0.5 s after
// (measured 2026-09-24, voice M4, 28 renders), so two sentences spoken back to
// back sat 0.75-1.1 s apart, against 0.2-0.7 s (mean 0.38) between the same
// sentences in one render: each sentence restarted like a new utterance. Cut to
// the speech, plus a short lead-in that keeps soft onsets and a tail that
// leaves the model's own pause between sentences. The floor is -50 dBFS.
const SILENCE = 10 ** (-50 / 20);
const LEAD_S = 0.05;
const TAIL_S = 0.35;
function trimSilence(wav: Float32Array, sampleRate: number): Float32Array {
  let first = 0, last = wav.length - 1;
  while (first <= last && Math.abs(wav[first]!) < SILENCE) first++;
  while (last > first && Math.abs(wav[last]!) < SILENCE) last--;
  if (first > last) return new Float32Array(0);
  return wav.slice(Math.max(0, first - Math.round(LEAD_S * sampleRate)), Math.min(wav.length, last + 1 + Math.round(TAIL_S * sampleRate)));
}

interface Cfg { ae: { sample_rate: number; base_chunk_size: number }; ttl: { chunk_compress_factor: number; latent_dim: number } }
interface Style { ttl: ort.Tensor; dp: ort.Tensor }

export class Supertonic {
  private constructor(
    private cfg: Cfg,
    private indexer: number[],
    private dp: ort.InferenceSession,
    private textEnc: ort.InferenceSession,
    private vectorEst: ort.InferenceSession,
    private vocoder: ort.InferenceSession,
  ) {}
  readonly styles = new Map<string, Style>();
  get sampleRate(): number { return this.cfg.ae.sample_rate; }

  static async load(device: "webgpu" | "wasm", onProgress?: Progress): Promise<Supertonic> {
    const [cfg, indexer] = await Promise.all([
      cachedFetch(`${HF}/onnx/tts.json`).then((b) => JSON.parse(new TextDecoder().decode(b)) as Cfg),
      cachedFetch(`${HF}/onnx/unicode_indexer.json`).then((b) => JSON.parse(new TextDecoder().decode(b)) as number[]),
    ]);
    // WebGPU first with WASM fallback, mirroring the reference example.
    const providers = device === "webgpu" ? ["webgpu", "wasm"] : ["wasm"];
    const session = async (name: string) =>
      ort.InferenceSession.create(await cachedFetch(`${HF}/onnx/${name}.onnx`, onProgress), { executionProviders: providers as never });
    const dp = await session("duration_predictor");
    const textEnc = await session("text_encoder");
    const vectorEst = await session("vector_estimator");
    const vocoder = await session("vocoder");
    return new Supertonic(cfg, indexer, dp, textEnc, vectorEst, vocoder);
  }

  private async style(voice: string): Promise<Style> {
    const cached = this.styles.get(voice);
    if (cached) return cached;
    const raw = JSON.parse(new TextDecoder().decode(await cachedFetch(`${HF}/voice_styles/${voice}.json`))) as {
      style_ttl: { dims: number[]; data: unknown }; style_dp: { dims: number[]; data: unknown };
    };
    const flat = (x: unknown): Float32Array => new Float32Array((x as number[]).flat(Infinity as 1) as number[]);
    const s: Style = {
      ttl: new ort.Tensor("float32", flat(raw.style_ttl.data), [1, raw.style_ttl.dims[1]!, raw.style_ttl.dims[2]!]),
      dp: new ort.Tensor("float32", flat(raw.style_dp.data), [1, raw.style_dp.dims[1]!, raw.style_dp.dims[2]!]),
    };
    this.styles.set(voice, s);
    return s;
  }

  /** Synthesize one sentence/chunk in `lang` (ISO 639-1) → mono Float32 PCM at cfg sample rate. */
  async synthesize(text: string, voice: string, speed = 1, lang = "en"): Promise<Float32Array> {
    const style = await this.style(voice);
    const processed = preprocess(text, lang);

    // text ids + mask
    const ids = new BigInt64Array(processed.length);
    for (let i = 0; i < processed.length; i++) {
      const cp = processed.codePointAt(i)!;
      ids[i] = BigInt(cp < this.indexer.length ? this.indexer[cp]! : -1);
    }
    const textIds = new ort.Tensor("int64", ids, [1, processed.length]);
    const textMask = new ort.Tensor("float32", new Float32Array(processed.length).fill(1), [1, 1, processed.length]);

    // duration (reference applies a 1.05 base speed)
    const dpOut = await this.dp.run({ text_ids: textIds, style_dp: style.dp, text_mask: textMask });
    const duration = (dpOut.duration!.data[0] as number) / (1.05 * speed);

    // text embedding
    const encOut = await this.textEnc.run({ text_ids: textIds, style_ttl: style.ttl, text_mask: textMask });
    const textEmb = encOut.text_emb!;

    // noisy latent [1, latentDim*compress, latentLen]
    const { ae, ttl } = this.cfg;
    const chunk = ae.base_chunk_size * ttl.chunk_compress_factor;
    const wavLen = Math.floor(duration * ae.sample_rate);
    const latentLen = Math.max(1, Math.floor((wavLen + chunk - 1) / chunk));
    const latentDim = ttl.latent_dim * ttl.chunk_compress_factor;
    let xt: Float32Array<ArrayBufferLike> = new Float32Array(latentDim * latentLen);
    const noise = seededNormal(voice);
    for (let i = 0; i < xt.length; i++) xt[i] = noise();
    const latentMask = new ort.Tensor("float32", new Float32Array(latentLen).fill(1), [1, 1, latentLen]);
    const totalStep = new ort.Tensor("float32", new Float32Array([STEPS]), [1]);

    // flow-matching denoise loop
    for (let step = 0; step < STEPS; step++) {
      const out = await this.vectorEst.run({
        noisy_latent: new ort.Tensor("float32", xt, [1, latentDim, latentLen]),
        text_emb: textEmb,
        style_ttl: style.ttl,
        latent_mask: latentMask,
        text_mask: textMask,
        current_step: new ort.Tensor("float32", new Float32Array([step]), [1]),
        total_step: totalStep,
      });
      xt = out.denoised_latent!.data as Float32Array;
    }

    const voc = await this.vocoder.run({ latent: new ort.Tensor("float32", xt, [1, latentDim, latentLen]) });
    return trimSilence(voc.wav_tts!.data as Float32Array, ae.sample_rate);
  }
}

/** The ten preset voices shipped with supertonic-3. */
export const SUPERTONIC_VOICE_IDS = ["M1", "M2", "M3", "M4", "M5", "F1", "F2", "F3", "F4", "F5"] as const;
