"use strict";
// Bundle the agent service into a single CJS file the Electron app runs. The
// JSON-file DB keeps the bundle native-free; the ONE native piece — the
// sherpa-onnx voice-cloning addon — is loaded lazily via createRequire at
// runtime (never bundled), so it ships as a real node_modules dir next to
// agent.mjs and the app still boots fine without it.
const esbuild = require("esbuild");
const path = require("node:path");
const fs = require("node:fs");

const root = path.resolve(__dirname, "..", "..", "..");
const outdir = path.resolve(__dirname, "..", "dist", "agent");

// sherpa-onnx-node resolves its prebuilt binary from a SIBLING package
// (../sherpa-onnx-<platform>-<arch>/sherpa-onnx.node), so copy the JS package
// plus every platform package pnpm installed (realpath through the symlinks).
// A universal-mac / cross-platform release build must install both darwin
// archs (pnpm supportedArchitectures) before packing.
function copySherpa() {
  const nmSrc = path.join(root, "services/agent/node_modules");
  const nmOut = path.join(outdir, "node_modules");
  const names = fs.readdirSync(nmSrc).filter((n) => n === "sherpa-onnx-node" || /^sherpa-onnx-(darwin|win|linux)-/.test(n));
  if (!names.includes("sherpa-onnx-node")) { console.warn("[pack-agent] sherpa-onnx-node not installed — packing without voice cloning"); return; }
  // The platform packages live beside sherpa-onnx-node in the pnpm store, not
  // in the project node_modules — pull them from the resolved package's parent.
  const resolved = fs.realpathSync(path.join(nmSrc, "sherpa-onnx-node"));
  const storeDir = path.dirname(resolved);
  const platformPkgs = fs.readdirSync(storeDir).filter((n) => /^sherpa-onnx-(darwin|win|linux)-/.test(n));
  fs.cpSync(resolved, path.join(nmOut, "sherpa-onnx-node"), { recursive: true, dereference: true });
  for (const n of platformPkgs) {
    fs.cpSync(path.join(storeDir, n), path.join(nmOut, n), { recursive: true, dereference: true });
  }
  console.log(`[pack-agent] shipped sherpa-onnx-node + ${platformPkgs.join(", ") || "no platform pkgs (!)"} `);
}

esbuild.build({
  entryPoints: [path.join(root, "services/agent/src/server.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: path.join(outdir, "agent.mjs"),
  // ws pulls these optional native speedups; it works fine without them.
  // sherpa-onnx-node is a native addon shipped as node_modules (see above).
  external: ["bufferutil", "utf-8-validate", "sherpa-onnx-node"],
  // Some bundled CJS deps reference these — shim them for the ESM output.
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  logLevel: "info",
}).then(() => {
  copySherpa();
  console.log("[pack-agent] wrote dist/agent/agent.mjs");
}).catch((e) => { console.error(e); process.exit(1); });
