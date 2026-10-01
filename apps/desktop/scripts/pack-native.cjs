"use strict";
// Build ol-input and stage it as extraResources. The crate links statically
// (no per-dylib signing), so the staged directory is just the loader, its
// types, and the .node for the running platform. On macOS and Windows the
// computer-use helper is built and staged beside it.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const crate = path.resolve(__dirname, "..", "..", "..", "native", "ol-input");
const outdir = path.resolve(__dirname, "..", "dist", "ol-input");

execFileSync(process.execPath, [path.join(crate, "scripts", "build.cjs")], { stdio: "inherit" });

fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });
for (const file of ["index.js", "index.d.ts", "package.json"]) {
  fs.copyFileSync(path.join(crate, file), path.join(outdir, file));
}
// On macOS the build is one universal Mach-O, and the loader asks for it by the
// running arch: stage it under both names so Intel and Apple Silicon find it.
const built = path.join(crate, `ol-input.${process.platform}-${process.arch}.node`);
const archs = process.platform === "darwin" ? ["arm64", "x64"] : [process.arch];
for (const arch of archs) fs.copyFileSync(built, path.join(outdir, `ol-input.${process.platform}-${arch}.node`));
console.log(`[pack-native] staged ol-input for ${process.platform}-${process.arch}`);

// The computer-use helper ships on macOS (its own app bundle) and Windows (an
// executable) until its Linux backend lands; there the server falls back to
// ol-input's screen tools.
if (process.platform === "darwin" || process.platform === "win32") {
  const cu = path.resolve(__dirname, "..", "..", "..", "native", "openlive-cu");
  const helper = process.platform === "darwin" ? "OpenLive Computer Use.app" : "openlive-cu.exe";
  const staged = path.resolve(__dirname, "..", "dist", "computer-use");
  execFileSync(process.execPath, [path.join(cu, "scripts", "build.cjs")], { stdio: "inherit" });
  fs.rmSync(staged, { recursive: true, force: true });
  fs.mkdirSync(staged, { recursive: true });
  fs.cpSync(path.join(cu, "dist", helper), path.join(staged, helper), { recursive: true, verbatimSymlinks: true });
  console.log(`[pack-native] staged ${helper}`);
}
