"use strict";
// Builds the crate and drops the artifact next to index.js under the
// platform-arch name the loader looks for.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const debug = process.argv.includes("--debug");
const args = ["build"];
if (!debug) args.push("--release");

execFileSync("cargo", args, { cwd: root, stdio: "inherit" });

const built = {
  darwin: "libol_input.dylib",
  linux: "libol_input.so",
  win32: "ol_input.dll",
}[process.platform];
if (!built) throw new Error(`ol-input does not build on ${process.platform}`);

const from = path.join(root, "target", debug ? "debug" : "release", built);
const to = path.join(root, `ol-input.${process.platform}-${process.arch}.node`);
fs.copyFileSync(from, to);
console.log(`[ol-input] ${path.basename(to)}`);
