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

// ── text preprocessing (reference UnicodeProcessor, English path) ────────────
function preprocess(text: string): string {
  text = text.normalize("NFKD")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu, "")
    .replace(/[–‑—]/g, "-").replace(/_/g, " ")
    .replace(/[“”]/g, '"').replace(/[‘’´`]/g, "'")
    .replace(/[[\]|/#→←]/g, " ")
    .replace(/[♥☆♡©\\]/g, "")
    .replaceAll("@", " at ").replaceAll("e.g.,", "for example, ").replaceAll("i.e.,", "that is, ")
    .replace(/ ([,.!?;:'])/g, "$1")
    .replace(/""+/g, '"').replace(/''+/g, "'")
    .replace(/\s+/g, " ").trim();
  if (!/[.!?;:,'")\]}…。」』】〉》›»]$/.test(text)) text += ".";
  return `<en>${text}</en>`;
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

  /** Synthesize one sentence/chunk → mono Float32 PCM at cfg sample rate. */
  async synthesize(text: string, voice: string, speed = 1): Promise<Float32Array> {
    const style = await this.style(voice);
    const processed = preprocess(text);

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
    for (let i = 0; i < xt.length; i++) {
      const u1 = Math.max(0.0001, Math.random());
      xt[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * Math.random());
    }
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
    return voc.wav_tts!.data as Float32Array;
  }
}

/** The ten preset voices shipped with supertonic-3. */
export const SUPERTONIC_VOICE_IDS = ["M1", "M2", "M3", "M4", "M5", "F1", "F2", "F3", "F4", "F5"] as const;
