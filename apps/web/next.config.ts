import type { NextConfig } from "next";
import { join } from "node:path";

// Live voice runs on-device AI models (Whisper / Kokoro / smart-turn) via
// transformers.js + onnxruntime-web: the weights download from the Hugging Face
// hub, the ort runtime instantiates WebAssembly (needs 'wasm-unsafe-eval') and
// spins up blob: workers/modules. So connect-src must allow the model hosts and
// blob:, and script/worker-src must allow blob:. The LLM turn is a same-origin
// POST to /api/turn ('self'), so no extra connect-src host is needed for it.
const MODEL_HOSTS = "https://huggingface.co https://*.huggingface.co https://*.hf.co https://cdn.jsdelivr.net";
// React's dev mode needs 'unsafe-eval' (callstack reconstruction); prod never
// does. Add it in development only so the strict prod CSP stays tight.
const DEV_EVAL = process.env.NODE_ENV !== "production" ? " 'unsafe-eval'" : "";
const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  `connect-src 'self' blob: data: ${MODEL_HOSTS}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "style-src 'self' 'unsafe-inline'",
  // onnxruntime-web + vad-web load their wasm-loader scripts from jsdelivr.
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${DEV_EVAL} blob: https://cdn.jsdelivr.net`,
].join("; ");

const config: NextConfig = {
  // Transpile our workspace TS packages (consumed as source).
  transpilePackages: ["@openlive/shared", "@openlive/harness"],
  // Pin the workspace root so file tracing is deterministic in the monorepo.
  turbopack: { root: join(import.meta.dirname, "..", "..") },
  outputFileTracingRoot: join(import.meta.dirname, "..", ".."),
  async headers() {
    return [{ source: "/:path*", headers: [{ key: "Content-Security-Policy", value: CSP }] }];
  },
};

export default config;
