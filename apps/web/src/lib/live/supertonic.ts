/// <reference lib="webworker" />
// Supertonic TTS (Supertone) in the browser: the shared synthesis
// (@openlive/shared/speech/supertonic) on onnxruntime-web. 44.1 kHz output.
// Runs inside models.worker.ts and shares its onnxruntime-web module instance.
import * as ort from "onnxruntime-web";
import { Supertonic } from "@openlive/shared/speech/supertonic";

const HF = "https://huggingface.co/Supertone/supertonic-3/resolve/main";
export const SUPERTONIC_SAMPLE_HINT = 44100; // real rate comes from tts.json

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

/** Supertonic on onnxruntime-web, WebGPU first with WASM fallback as the
 *  reference example does, its files fetched once from the hub into the Cache API. */
export function loadSupertonic(device: "webgpu" | "wasm", onProgress?: Progress): Promise<Supertonic> {
  const bytes = (file: string, progress?: Progress) => cachedFetch(`${HF}/${file}`, progress);
  return Supertonic.load(ort, {
    json: async (file) => JSON.parse(new TextDecoder().decode(await bytes(file))),
    model: async (file) => new Uint8Array(await bytes(file, onProgress)),
  }, { executionProviders: device === "webgpu" ? ["webgpu", "wasm"] : ["wasm"] });
}

/** The ten preset voices shipped with supertonic-3. */
export const SUPERTONIC_VOICE_IDS = ["M1", "M2", "M3", "M4", "M5", "F1", "F2", "F3", "F4", "F5"] as const;
