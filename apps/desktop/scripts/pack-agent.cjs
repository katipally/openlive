"use strict";
// Bundle the agent service into a single CJS file the Electron app runs. The
// JSON-file DB keeps the bundle native-free; the native pieces (the
// sherpa-onnx voice addon and onnxruntime-node for Supertonic on this computer)
// are loaded lazily via createRequire at runtime (never bundled), so they ship
// as real node_modules dirs next to agent.mjs and the app still boots fine
// without them.
const esbuild = require("esbuild");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..", "..");
const outdir = path.resolve(__dirname, "..", "dist", "agent");

// The platform packages the TARGET OS needs. macOS ships BOTH archs — the DMG
// is universal and the addon picks by os.arch() at runtime; Windows/Linux ship
// their own. (Builds run on the target OS, matching the repo's release flow.)
function sherpaTargets() {
  if (process.platform === "darwin") return ["darwin-arm64", "darwin-x64"];
  if (process.platform === "win32") return ["win-x64"];
  return [`linux-${os.arch()}`];
}

// sherpa-onnx-node resolves its prebuilt binary from a SIBLING package
// (../sherpa-onnx-<platform>-<arch>/sherpa-onnx.node), so ship the JS package
// plus each target platform package next to agent.mjs. pnpm only installs the
// build machine's own arch — any missing target is fetched with `npm pack`
// (same pinned version) so a universal mac build works from either machine.
function copySherpa() {
  const nmSrc = path.join(root, "services/agent/node_modules");
  const nmOut = path.join(outdir, "node_modules");
  if (!fs.existsSync(path.join(nmSrc, "sherpa-onnx-node"))) { console.warn("[pack-agent] sherpa-onnx-node not installed — packing without voice cloning"); return; }
  const resolved = fs.realpathSync(path.join(nmSrc, "sherpa-onnx-node"));
  const storeDir = path.dirname(resolved);
  const version = JSON.parse(fs.readFileSync(path.join(resolved, "package.json"), "utf8")).version;
  fs.cpSync(resolved, path.join(nmOut, "sherpa-onnx-node"), { recursive: true, dereference: true });

  const shipped = [];
  for (const t of sherpaTargets()) {
    const name = `sherpa-onnx-${t}`;
    const local = path.join(storeDir, name);
    if (fs.existsSync(local)) {
      fs.cpSync(local, path.join(nmOut, name), { recursive: true, dereference: true });
    } else {
      // Cross-arch fetch (e.g. darwin-x64 on an arm64 Mac): npm pack + extract.
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sherpa-pack-"));
      execSync(`npm pack ${name}@${version} --pack-destination "${tmp}"`, { stdio: "pipe" });
      const tgz = fs.readdirSync(tmp).find((f) => f.endsWith(".tgz"));
      execSync(`tar -xzf "${path.join(tmp, tgz)}" -C "${tmp}"`, { stdio: "pipe" }); // bsdtar ships on macOS + Win10+
      fs.cpSync(path.join(tmp, "package"), path.join(nmOut, name), { recursive: true });
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    shipped.push(name);
  }
  console.log(`[pack-agent] shipped sherpa-onnx-node@${version} + ${shipped.join(", ")}`);
}

// onnxruntime-node carries every platform's binary (bin/napi-v6/<os>/<arch>);
// only the target OS's ship. It has none for Intel Macs (1.30.0), where
// Supertonic stays in the browser. On Linux x64 its postinstall adds the CUDA
// provider libraries, which ship as installed.
function copyOrt() {
  const nmOut = path.join(outdir, "node_modules");
  let resolved;
  try { resolved = fs.realpathSync(path.join(root, "services/agent/node_modules/onnxruntime-node")); } catch { console.warn("[pack-agent] onnxruntime-node not installed, packing without it"); return; }
  const os_ = { darwin: "darwin", win32: "win32" }[process.platform] ?? "linux";
  fs.cpSync(resolved, path.join(nmOut, "onnxruntime-node"), {
    recursive: true, dereference: true,
    filter: (src) => { const rel = path.relative(path.join(resolved, "bin", "napi-v6"), src).split(path.sep); return rel[0] === ".." || rel[0] === "" || rel[0] === os_; },
  });
  // Its one runtime dependency, resolved as it resolves it.
  fs.cpSync(fs.realpathSync(path.join(resolved, "..", "onnxruntime-common")), path.join(nmOut, "onnxruntime-common"), { recursive: true, dereference: true });
  console.log(`[pack-agent] shipped onnxruntime-node (${os_} binaries) + onnxruntime-common`);
}

esbuild.build({
  // The native speech worker is its own entry: native.ts loads it by URL
  // (./native-worker.mjs next to agent.mjs), so it cannot live inside agent.mjs.
  entryPoints: {
    agent: path.join(root, "services/agent/src/server.ts"),
    "native-worker": path.join(root, "services/agent/src/voice/native-worker.ts"),
  },
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outdir,
  outExtension: { ".js": ".mjs" },
  // ws pulls these optional native speedups; it works fine without them.
  // sherpa-onnx-node and onnxruntime-node are native addons shipped as node_modules (see above).
  external: ["bufferutil", "utf-8-validate", "sherpa-onnx-node", "onnxruntime-node"],
  // Some bundled CJS deps reference these — shim them for the ESM output.
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  logLevel: "info",
}).then(() => {
  copySherpa();
  copyOrt();
  console.log("[pack-agent] wrote dist/agent/agent.mjs + native-worker.mjs");
}).catch((e) => { console.error(e); process.exit(1); });
