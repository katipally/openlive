"use strict";
// Bundle the agent service into a single CJS file the Electron app runs. No
// native modules anymore (the DB is JSON files), so everything bundles clean.
const esbuild = require("esbuild");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..", "..");
const outdir = path.resolve(__dirname, "..", "dist", "agent");

esbuild.build({
  entryPoints: [path.join(root, "services/agent/src/server.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: path.join(outdir, "agent.mjs"),
  // ws pulls these optional native speedups; it works fine without them.
  external: ["bufferutil", "utf-8-validate"],
  // Some bundled CJS deps reference these — shim them for the ESM output.
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  logLevel: "info",
}).then(() => {
  console.log("[pack-agent] wrote dist/agent/agent.mjs");
}).catch((e) => { console.error(e); process.exit(1); });
