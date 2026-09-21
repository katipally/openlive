"use strict";
// Build ol-input and stage it as extraResources. The crate links statically
// (no per-dylib signing), so the staged directory is just the loader, its
// types, and the one .node the running platform needs.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const crate = path.resolve(__dirname, "..", "..", "..", "native", "ol-input");
const outdir = path.resolve(__dirname, "..", "dist", "ol-input");

execFileSync(process.execPath, [path.join(crate, "scripts", "build.cjs")], { stdio: "inherit" });

fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });
for (const file of ["index.js", "index.d.ts", "package.json", `ol-input.${process.platform}-${process.arch}.node`]) {
  fs.copyFileSync(path.join(crate, file), path.join(outdir, file));
}
console.log(`[pack-native] staged ol-input for ${process.platform}-${process.arch}`);
