"use strict";
// Build ol-input and stage it as extraResources. The crate links statically
// (no per-dylib signing), so the staged directory is just the loader, its
// types, and the .node for the running platform. The computer-use helper is
// built and staged beside it.
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

// The computer-use helper ships on every platform: its own app bundle on
// macOS, a bare executable on Windows and Linux.
const cu = path.resolve(__dirname, "..", "..", "..", "native", "openlive-cu");
const helper = { darwin: "OpenLive Computer Use.app", win32: "openlive-cu.exe" }[process.platform] ?? "openlive-cu";
const staged = path.resolve(__dirname, "..", "dist", "computer-use");
execFileSync(process.execPath, [path.join(cu, "scripts", "build.cjs")], { stdio: "inherit" });
fs.rmSync(staged, { recursive: true, force: true });
fs.mkdirSync(staged, { recursive: true });
fs.cpSync(path.join(cu, "dist", helper), path.join(staged, helper), { recursive: true, verbatimSymlinks: true });
console.log(`[pack-native] staged ${helper}`);
