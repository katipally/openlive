// Chatterbox-Turbo (Resemble AI, MIT) on onnxruntime-node, the bake-off's
// expressive candidate: the four-graph pipeline of the ResembleAI/chatterbox-turbo-ONNX
// model card (speech encoder once per voice, then per text a GPT-2 LM over
// speech tokens with a KV cache, greedy with the card's repetition penalty,
// and the conditional decoder to a 24 kHz waveform). Greedy, so one text and
// voice always render the same audio. Paralinguistic tags like [laugh] are
// tokens of its own tokenizer and pass straight through.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const agentRequire = createRequire(new URL("../../../services/agent/package.json", import.meta.url));
const START = 6561, STOP = 6562, SILENCE = 4299, HEADS = 16, HEAD_DIM = 64, PENALTY = 1.2;
export const CHATTERBOX_RATE = 24000;
// Speech tokens are 25 per second; a text gets 3 s plus 1 s per 8 characters
// before a runaway render is cut, well past any real reading of it.
const TOKENS_PER_S = 25;

type Tensor = { data: Float32Array | BigInt64Array; dims: readonly number[] };
type Session = { run(feeds: Record<string, unknown>): Promise<Record<string, Tensor>>; inputNames: readonly string[]; release(): Promise<void> };
type Ort = {
  Tensor: new (type: string, data: Float32Array | BigInt64Array, dims: number[]) => Tensor;
  InferenceSession: { create(path: string, opts: object): Promise<Session> };
};
export interface Voice { cond: Tensor; prompt: BigInt64Array; emb: Tensor; feat: Tensor }
/** `last`: the latest synth's LM and decoder wall times and its speech token count. */
export interface Chatterbox { voice(wav: Float32Array): Promise<Voice>; synth(text: string, v: Voice): Promise<Float32Array>; close(): Promise<void>; last: { lmMs: number; decMs: number; tokens: number } }

/** `lm` (with its embeddings) and `decoder` pick the card's file suffix per graph: "q4", "quantized" (q8), "fp16" or "" (fp32). */
export async function loadChatterbox(dir: string, { lm: lmType, decoder: decType }: { lm: string; decoder: string }, provider: string, numThreads: number): Promise<Chatterbox> {
  const ort = agentRequire("onnxruntime-node") as Ort;
  const { Tokenizer } = await import(pathToFileURL(agentRequire.resolve("@huggingface/tokenizers")).href);
  const json = async (f: string) => JSON.parse(await readFile(join(dir, f), "utf8"));
  const tok = new Tokenizer(await json("tokenizer.json"), await json("tokenizer_config.json"));
  const opts = { executionProviders: [provider], intraOpNumThreads: numThreads, interOpNumThreads: 1, logSeverityLevel: 3 };
  const open = (name: string, d: string) => ort.InferenceSession.create(join(dir, "onnx", `${name}${d ? `_${d}` : ""}.onnx`), opts);
  const [embed, lm, decoder] = await Promise.all([open("embed_tokens", lmType), open("language_model", lmType), open("conditional_decoder", decType)]);
  const i64 = (a: ArrayLike<number | bigint>, dims = [1, a.length]) => new ort.Tensor("int64", BigInt64Array.from(a as ArrayLike<bigint>, (x) => BigInt(x)), dims);
  const kvNames = lm.inputNames.filter((n) => n.startsWith("past_key_values"));

  const last = { lmMs: 0, decMs: 0, tokens: 0 };
  return {
    last,
    // The speech encoder runs once per voice; its session is not kept.
    async voice(wav) {
      const enc = await open("speech_encoder", "quantized");
      const o = await enc.run({ audio_values: new ort.Tensor("float32", wav, [1, wav.length]) });
      await enc.release();
      return { cond: o.audio_features!, prompt: o.audio_tokens!.data as BigInt64Array, emb: o.speaker_embeddings!, feat: o.speaker_features! };
    },
    // O(tokens^2) in the LM's attention; tokens bounded by the text's length.
    async synth(text, v) {
      const t0 = performance.now();
      const ids: number[] = tok.encode(text).ids;
      const budget = Math.min(1000, Math.round(TOKENS_PER_S * (3 + text.length / 8)));
      const cond = v.cond.data as Float32Array, width = v.cond.dims[2]!;
      const first = (await embed.run({ input_ids: i64(ids) })).inputs_embeds!.data as Float32Array;
      const seq = cond.length / width + ids.length;
      const x0 = new Float32Array(seq * width);
      x0.set(cond); x0.set(first, cond.length);
      let feeds: Record<string, unknown> = { inputs_embeds: new ort.Tensor("float32", x0, [1, seq, width]) };
      for (const n of kvNames) feeds[n] = new ort.Tensor("float32", new Float32Array(0), [1, HEADS, 0, HEAD_DIM]);
      let len = seq;
      const out: number[] = [], seen = new Set<number>([START]);
      for (let step = 0; step < budget; step++) {
        const r = await lm.run({ ...feeds, attention_mask: i64(new Array(len).fill(1)), position_ids: i64(step ? [len - 1] : Array.from({ length: len }, (_, i) => i)) });
        const logits = r.logits!.data as Float32Array, vocab = r.logits!.dims[2]!, base = logits.length - vocab;
        let best = -1, bestScore = -Infinity;
        for (let k = 0; k < vocab; k++) {
          let s = logits[base + k]!;
          if (seen.has(k)) s = s < 0 ? s * PENALTY : s / PENALTY;
          if (s > bestScore) { bestScore = s; best = k; }
        }
        if (best === STOP) break;
        out.push(best); seen.add(best);
        feeds = { inputs_embeds: (await embed.run({ input_ids: i64([best]) })).inputs_embeds };
        kvNames.forEach((n, j) => { feeds[n] = r[`present.${n.split(".").slice(1).join(".")}`]; });
        len++;
      }
      const t1 = performance.now();
      const tokens = [...v.prompt, ...out.map(BigInt), BigInt(SILENCE), BigInt(SILENCE), BigInt(SILENCE)];
      const wav = await decoder.run({ speech_tokens: i64(tokens), speaker_embeddings: v.emb, speaker_features: v.feat });
      Object.assign(last, { lmMs: t1 - t0, decMs: performance.now() - t1, tokens: out.length });
      return wav.waveform!.data as Float32Array;
    },
    close: async () => { await Promise.all([embed.release(), lm.release(), decoder.release()]); },
  };
}
