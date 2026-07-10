import type { NextConfig } from "next";
import { join } from "node:path";

// CSP for the app. The canvas renders model-authored HTML DIRECTLY in the app
// document (no iframe), so its scripts run in-origin — connect-src is the main
// exfiltration fence, object-src/frame-src none block plugin/iframe escapes.
//
// Live voice runs on-device AI models (Whisper / Kokoro / smart-turn) via
// transformers.js + onnxruntime-web: the weights download from the Hugging Face
// hub, the ort runtime instantiates WebAssembly (needs 'wasm-unsafe-eval') and
// spins up blob: workers/modules. So connect-src must allow the model hosts and
// blob:, and script/worker-src must allow blob:.
// ponytail: this widens the canvas-script exfiltration surface to the HF/jsdelivr
// hosts (not arbitrary). Acceptable pre-launch; to fully re-fence, proxy model
// downloads through a same-origin /api route with a host allowlist.
const MODEL_HOSTS = "https://huggingface.co https://*.huggingface.co https://*.hf.co https://cdn.jsdelivr.net";
// Live voice connects to the agent over a WebSocket (direct, not via the Next
// proxy). Allow its origin in connect-src, derived from env (dev: ws://localhost:8787).
const LIVE_WS = (() => {
  const raw = process.env.NEXT_PUBLIC_LIVE_WS_URL || `ws://localhost:${process.env.AGENT_PORT || 8787}`;
  try { return new URL(raw).origin; } catch { return "ws://localhost:8787"; }
})();
// React's dev mode needs 'unsafe-eval' (callstack reconstruction); prod never
// does. Add it in development only so the strict prod CSP stays tight.
const DEV_EVAL = process.env.NODE_ENV !== "production" ? " 'unsafe-eval'" : "";
const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  `connect-src 'self' blob: data: ${LIVE_WS} ${MODEL_HOSTS}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "style-src 'self' 'unsafe-inline'",
  // onnxruntime-web + vad-web load their wasm-loader scripts from jsdelivr.
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${DEV_EVAL} blob: https://cdn.jsdelivr.net`,
].join("; ");

const config: NextConfig = {
  // Self-contained server output for the Electron desktop build.
  output: "standalone",
  // The UI uses no next/image, so skip Next's image optimizer — that drops the
  // native `sharp` dep, which (a) is arch-specific and blocks the universal macOS
  // build and (b) just bloats the bundle here.
  images: { unoptimized: true },
  // Transpile our workspace TS packages; keep native deps out of the bundle.
  transpilePackages: ["@openlive/db", "@openlive/shared", "@openlive/harness"],
  // Pin the workspace root so file tracing is deterministic in the monorepo.
  turbopack: { root: join(import.meta.dirname, "..", "..") },
  outputFileTracingRoot: join(import.meta.dirname, "..", ".."),
  async headers() {
    return [{ source: "/:path*", headers: [{ key: "Content-Security-Policy", value: CSP }] }];
  },
};

export default config;
