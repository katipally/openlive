// Supertonic TTS (Supertone): four small ONNX models (duration predictor, text
// encoder, flow vector estimator, vocoder, about 66M params) and a unicode
// indexer; no G2P and no tokenizer. Adapted from the MIT-licensed reference
// implementation (github.com/supertone-inc/supertonic web example), with the
// nested-array latents flattened to Float32Arrays. Model license: OpenRAIL-M.
// One implementation for both runtimes: the browser worker passes
// onnxruntime-web (apps/web/src/lib/live/supertonic.ts), the agent
// onnxruntime-node (services/agent/src/voice/native-worker.ts).

// The slice of onnxruntime-common both runtimes export.
interface Tensor { readonly data: unknown }
interface Session { run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>> }
export interface Ort {
  Tensor: new (type: "float32" | "int64", data: Float32Array | BigInt64Array, dims: readonly number[]) => Tensor;
  InferenceSession: { create(model: Uint8Array | string, options?: object): Promise<Session> };
}
/** Where the files come from, by their path in the Hugging Face repo
 *  ("onnx/tts.json"): parsed JSON, and a model as bytes or a local path. */
export interface SupertonicFiles { json(file: string): Promise<unknown>; model(file: string): Promise<Uint8Array | string> }

// ponytail: 8 denoising steps = the reference default; lower if first-audio
// latency measures worse than Kokoro on target machines.
const STEPS = 8;
// Each chunk of a reply is a separate render, and each render's pitch moves
// with its noise draw. At 0.8 of the reference's unit noise, adjacent chunks
// of a reply came 9% closer in pitch on average (19% at the 90th percentile)
// over all ten voices, with each sentence's own pitch range unchanged (within
// 0.4 semitones; measured 2026-09-30, tools/voice-regress corpus).
const NOISE_SCALE = 0.8;
// The duration predictor gives a short text less time a character: English
// chunks under 60 characters played 4-18% faster than ones over 100 (about 10%
// on a typical voice, 18% on F2; same measurement). A chunk predicted shorter
// than LONG_S (100 English characters, 5.6-7.0 s over the ten voices; 30 Chinese
// ones take as long) is stretched by 1 + 0.09 ln(LONG_S / predicted), at most 15%.
// Measured in time, not characters, so a language spoken slower per character
// is not stretched for it.
const SHORT_STRETCH = 0.09;
const MAX_STRETCH = 1.15;
const LONG_S = 6.5;

// ── text preprocessing (reference UnicodeProcessor, web/helper.js) ───────────
// The language rides as a tag around the text, one of the model's 31 codes
// (huggingface.co/Supertone/supertonic-3). NFKD splits Hangul into jamo, as the
// reference does: the unicode indexer holds the jamo, not the syllables.
// "@", "e.g." and the like arrive already spelled out (toSpeech, voiceText.ts).
function preprocess(text: string, lang: string): string {
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

interface Cfg { ae: { sample_rate: number; base_chunk_size: number }; ttl: { chunk_compress_factor: number; latent_dim: number } }
interface Style { ttl: Tensor; dp: Tensor }

export class Supertonic {
  private constructor(
    private ort: Ort,
    private files: SupertonicFiles,
    private cfg: Cfg,
    private indexer: number[],
    private dp: Session,
    private textEnc: Session,
    private vectorEst: Session,
    private vocoder: Session,
  ) {}
  readonly styles = new Map<string, Style>();
  get sampleRate(): number { return this.cfg.ae.sample_rate; }

  /** `options` are the runtime's session options: its execution providers and threads. */
  static async load(ort: Ort, files: SupertonicFiles, options: object): Promise<Supertonic> {
    const [cfg, indexer] = await Promise.all([files.json("onnx/tts.json") as Promise<Cfg>, files.json("onnx/unicode_indexer.json") as Promise<number[]>]);
    const session = async (name: string) => ort.InferenceSession.create(await files.model(`onnx/${name}.onnx`), options);
    const dp = await session("duration_predictor");
    const textEnc = await session("text_encoder");
    const vectorEst = await session("vector_estimator");
    const vocoder = await session("vocoder");
    return new Supertonic(ort, files, cfg, indexer, dp, textEnc, vectorEst, vocoder);
  }

  private async style(voice: string): Promise<Style> {
    const cached = this.styles.get(voice);
    if (cached) return cached;
    const raw = await this.files.json(`voice_styles/${voice}.json`) as {
      style_ttl: { dims: number[]; data: unknown }; style_dp: { dims: number[]; data: unknown };
    };
    const flat = (x: unknown): Float32Array => new Float32Array((x as number[]).flat(Infinity as 1) as number[]);
    const s: Style = {
      ttl: new this.ort.Tensor("float32", flat(raw.style_ttl.data), [1, raw.style_ttl.dims[1]!, raw.style_ttl.dims[2]!]),
      dp: new this.ort.Tensor("float32", flat(raw.style_dp.data), [1, raw.style_dp.dims[1]!, raw.style_dp.dims[2]!]),
    };
    this.styles.set(voice, s);
    return s;
  }

  /** Synthesize one sentence/chunk in `lang` (ISO 639-1) → mono Float32 PCM at cfg sample rate. */
  async synthesize(text: string, voice: string, speed = 1, lang = "en"): Promise<Float32Array> {
    const { Tensor } = this.ort;
    const style = await this.style(voice);
    const processed = preprocess(text, lang);

    // text ids + mask
    const ids = new BigInt64Array(processed.length);
    for (let i = 0; i < processed.length; i++) {
      const cp = processed.codePointAt(i)!;
      ids[i] = BigInt(cp < this.indexer.length ? this.indexer[cp]! : -1);
    }
    const textIds = new Tensor("int64", ids, [1, processed.length]);
    const textMask = new Tensor("float32", new Float32Array(processed.length).fill(1), [1, 1, processed.length]);

    // duration (reference applies a 1.05 base speed)
    const dpOut = await this.dp.run({ text_ids: textIds, style_dp: style.dp, text_mask: textMask });
    const predicted = ((dpOut.duration!.data as Float32Array)[0]!) / 1.05;
    const stretch = Math.min(MAX_STRETCH, Math.max(1, 1 + SHORT_STRETCH * Math.log(LONG_S / predicted)));
    const duration = (predicted / speed) * stretch;

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
    for (let i = 0; i < xt.length; i++) xt[i] = NOISE_SCALE * noise();
    const latentMask = new Tensor("float32", new Float32Array(latentLen).fill(1), [1, 1, latentLen]);
    const totalStep = new Tensor("float32", new Float32Array([STEPS]), [1]);

    // flow-matching denoise loop
    for (let step = 0; step < STEPS; step++) {
      const out = await this.vectorEst.run({
        noisy_latent: new Tensor("float32", xt, [1, latentDim, latentLen]),
        text_emb: textEmb,
        style_ttl: style.ttl,
        latent_mask: latentMask,
        text_mask: textMask,
        current_step: new Tensor("float32", new Float32Array([step]), [1]),
        total_step: totalStep,
      });
      xt = out.denoised_latent!.data as Float32Array;
    }

    const voc = await this.vocoder.run({ latent: new Tensor("float32", xt, [1, latentDim, latentLen]) });
    return voc.wav_tts!.data as Float32Array;
  }
}
