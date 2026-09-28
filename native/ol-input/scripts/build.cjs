"use strict";
// Builds the crate and drops the artifact next to index.js under the
// platform-arch name the loader looks for.
//
// --if-stale is the dev flow's form (predesktop:dev): a no-op while the binary
// matches its sources, and a missing toolchain or a failed build only warns,
// since the rest of the app runs without Flow and Flow says what is missing.
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { sourceHash, stampPath, staleReason, readStamp } = require("./stale.cjs");

const root = path.join(__dirname, "..");
const debug = process.argv.includes("--debug");
const ifStale = process.argv.includes("--if-stale");
const profile = debug ? "debug" : "release";
const library = { darwin: "libol_input.dylib", linux: "libol_input.so", win32: "ol_input.dll" }[process.platform];
if (!library) throw new Error(`ol-input does not build on ${process.platform}`);

const cargo = (args) => {
  try { execFileSync("cargo", args, { cwd: root, stdio: "inherit" }); }
  catch (e) { giveUp(`cargo ${args.join(" ")} failed (${e.message.split("\n")[0]}).`); }
};
const build = (target) => {
  const args = ["build"];
  if (!debug) args.push("--release");
  if (target) args.push("--target", target);
  cargo(args);
  return path.join(root, "target", target ?? "", profile, library);
};

const out = path.join(root, `ol-input.${process.platform}-${process.arch}.node`);
const hash = sourceHash(root);
const stamp = stampPath(root, out);

const TOOLCHAIN_HELP = {
  darwin: "Install Rust from https://rustup.rs and the Xcode Command Line Tools (`xcode-select --install`).",
  win32: "Install Rust (`winget install Rustlang.Rustup`, or https://rustup.rs) and the Visual Studio Build Tools with the \"Desktop development with C++\" workload.",
  linux: "Install Rust from https://rustup.rs and a C toolchain (`sudo apt install build-essential`, `sudo dnf groupinstall \"Development Tools\"` or your distro's equivalent).",
}[process.platform];

function giveUp(problem) {
  const message = `[ol-input] ${problem}\n[ol-input] ${TOOLCHAIN_HELP}\n[ol-input] Then run \`pnpm native:build\`. Until then OpenLive runs without Flow.`;
  if (!ifStale) throw new Error(message);
  console.warn(message);
  process.exit(0);
}

if (ifStale) {
  const why = staleReason({ binaryExists: fs.existsSync(out), stamp: readStamp(stamp), hash });
  if (!why) process.exit(0);
  console.log(`[ol-input] building the Flow input addon (${why}). The first build takes a few minutes.`);
}
if (spawnSync("cargo", ["--version"], { stdio: "ignore" }).error) giveUp("cargo was not found, so the Flow input addon cannot be built.");

// The macOS DMG is universal, and electron-builder merges the two single-arch
// passes: a single-arch addon staged into both is what breaks that merge. One
// universal Mach-O is identical in both passes, so it merges cleanly.
const universal = process.platform === "darwin" && !process.argv.includes("--host-only");
const targets = universal ? ["aarch64-apple-darwin", "x86_64-apple-darwin"] : [];
const installed = targets.length
  ? execFileSync("rustup", ["target", "list", "--installed"], { encoding: "utf8" })
  : "";

const missing = targets.filter((t) => !installed.includes(t));
if (missing.length) {
  throw new Error(`[ol-input] a universal addon needs \`rustup target add ${missing.join(" ")}\` (or pass --host-only for a local build)`);
}
if (targets.length) {
  const slices = targets.map(build);
  execFileSync("lipo", ["-create", ...slices, "-output", out], { stdio: "inherit" });
} else {
  fs.copyFileSync(build(null), out);
}
if (process.platform === "darwin") {
  // Leave the absolute build path out of a binary that gets signed.
  execFileSync("install_name_tool", ["-id", path.basename(out), out], { stdio: "inherit" });
}
fs.mkdirSync(path.dirname(stamp), { recursive: true });
fs.writeFileSync(stamp, hash);
console.log(`[ol-input] ${path.basename(out)}`);
