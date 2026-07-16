// Vendor the VAD runtime assets (Silero onnx + audio worklet + ort wasm loader)
// from node_modules into public/vad/ so the voice loop starts without touching a
// CDN. Runs before dev and build; public/vad is gitignored (binaries stay out of
// the repo, versions track package.json).
import { copyFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "public", "vad");
mkdirSync(out, { recursive: true });

// Resolved via the app's node_modules symlinks (pnpm); realpath for good measure.
// require.resolve can't be used — onnxruntime-web doesn't export ./package.json.
const nm = (pkg) => realpathSync(join(here, "..", "node_modules", pkg));
const vadDist = join(nm("@ricky0123/vad-web"), "dist");
const ortDist = join(nm("onnxruntime-web"), "dist");

const files = [
  [vadDist, "silero_vad_v5.onnx"],
  [vadDist, "vad.worklet.bundle.min.js"],
  // The VAD runs on the plain CPU wasm backend — only the threaded-simd pair is loaded.
  [ortDist, "ort-wasm-simd-threaded.mjs"],
  [ortDist, "ort-wasm-simd-threaded.wasm"],
];

for (const [dir, name] of files) {
  const src = join(dir, name);
  if (!existsSync(src)) { console.error(`copy-voice-assets: missing ${src}`); process.exit(1); }
  copyFileSync(src, join(out, name));
}
console.log(`copy-voice-assets: vendored ${files.length} files → public/vad/`);
