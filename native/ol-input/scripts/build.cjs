"use strict";
// Builds the crate and drops the artifact next to index.js under the
// platform-arch name the loader looks for.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const debug = process.argv.includes("--debug");
const profile = debug ? "debug" : "release";
const library = { darwin: "libol_input.dylib", linux: "libol_input.so", win32: "ol_input.dll" }[process.platform];
if (!library) throw new Error(`ol-input does not build on ${process.platform}`);

const cargo = (args) => execFileSync("cargo", args, { cwd: root, stdio: "inherit" });
const build = (target) => {
  const args = ["build"];
  if (!debug) args.push("--release");
  if (target) args.push("--target", target);
  cargo(args);
  return path.join(root, "target", target ?? "", profile, library);
};

const out = path.join(root, `ol-input.${process.platform}-${process.arch}.node`);

// The macOS DMG is universal, and electron-builder merges the two single-arch
// passes: a single-arch addon staged into both is what breaks that merge. One
// universal Mach-O is identical in both passes, so it merges cleanly.
const universal = process.platform === "darwin" && !process.argv.includes("--host-only");
const targets = universal ? ["aarch64-apple-darwin", "x86_64-apple-darwin"] : [];
const installed = targets.length
  ? execFileSync("rustup", ["target", "list", "--installed"], { encoding: "utf8" })
  : "";

if (targets.length && targets.every((t) => installed.includes(t))) {
  const slices = targets.map(build);
  execFileSync("lipo", ["-create", ...slices, "-output", out], { stdio: "inherit" });
} else {
  if (targets.length) {
    console.warn(`[ol-input] building host-only: run \`rustup target add ${targets.join(" ")}\` for a universal addon`);
  }
  fs.copyFileSync(build(null), out);
}
if (process.platform === "darwin") {
  // Leave the absolute build path out of a binary that gets signed.
  execFileSync("install_name_tool", ["-id", path.basename(out), out], { stdio: "inherit" });
}
console.log(`[ol-input] ${path.basename(out)}`);
