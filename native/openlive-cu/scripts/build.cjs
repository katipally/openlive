"use strict";
// Builds the computer-use helper. On macOS it becomes its own app bundle,
// "OpenLive Computer Use.app", so Accessibility and Screen Recording are
// granted to it and not to Electron; elsewhere it is a bare executable (on
// Windows with its manifest embedded by crates/helper/build.rs).
// Bundle layout and signing follow Orca's build-computer-macos.mjs (MIT,
// Copyright (c) 2026 Lovecast Inc.; see THIRD_PARTY_NOTICES).
//
// Signing: OPENLIVE_CU_SIGN_IDENTITY (or electron-builder's CSC_NAME) names a
// codesign identity; without one the bundle is signed ad hoc, which runs fine
// but gives TCC a new identity every build, so a dev grant does not survive a
// rebuild. A real identity also turns on the hardened runtime. Packaged builds
// are re-signed by electron-builder with the app's identity either way.
//
// --if-stale is the dev flow's form (pnpm native:build): a no-op while the
// output matches its sources, and a missing toolchain only warns.
// --host-only builds for this machine's arch instead of a universal binary.
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { sourceHash, stampPath, staleReason, readStamp } = require("../../ol-input/scripts/stale.cjs");

const root = path.join(__dirname, "..");
const INPUTS = ["Cargo.toml", "Cargo.lock", "crates", "entitlements.mac.plist", "scripts/build.cjs"];
const ifStale = process.argv.includes("--if-stale");
const universal = process.platform === "darwin" && !process.argv.includes("--host-only");
const exe = process.platform === "win32" ? "openlive-cu.exe" : "openlive-cu";

const APP = "OpenLive Computer Use.app";
const BUNDLE_ID = process.env.OPENLIVE_CU_BUNDLE_ID || "com.openlive.computer-use";
const dist = path.join(root, "dist");
const out = process.platform === "darwin" ? path.join(dist, APP) : path.join(dist, exe);
const binary = process.platform === "darwin" ? path.join(out, "Contents", "MacOS", exe) : out;

function giveUp(problem) {
  const message = `[openlive-cu] ${problem}\n[openlive-cu] Install Rust from https://rustup.rs, then run \`pnpm native:build\`. Until then OpenLive uses its built-in screen tools.`;
  if (!ifStale) throw new Error(message);
  console.warn(message);
  process.exit(0);
}

const hash = sourceHash(root, INPUTS);
const stamp = stampPath(root, out);
if (ifStale) {
  const why = staleReason({ binaryExists: fs.existsSync(binary), stamp: readStamp(stamp), hash });
  if (!why) process.exit(0);
  console.log(`[openlive-cu] building the computer-use helper (${why}).`);
}
if (spawnSync("cargo", ["--version"], { stdio: "ignore" }).error) giveUp("cargo was not found.");

const cargo = (target) => {
  const args = ["build", "--release", "-p", "openlive-cu", ...(target ? ["--target", target] : [])];
  try { execFileSync("cargo", args, { cwd: root, stdio: "inherit" }); }
  catch (e) { giveUp(`cargo ${args.join(" ")} failed (${e.message.split("\n")[0]}).`); }
  return path.join(root, "target", target ?? "", "release", exe);
};

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.dirname(binary), { recursive: true });
if (universal) {
  const targets = ["aarch64-apple-darwin", "x86_64-apple-darwin"];
  const installed = execFileSync("rustup", ["target", "list", "--installed"], { encoding: "utf8" });
  const missing = targets.filter((t) => !installed.includes(t));
  if (missing.length) throw new Error(`[openlive-cu] a universal build needs \`rustup target add ${missing.join(" ")}\` (or pass --host-only)`);
  execFileSync("lipo", ["-create", ...targets.map(cargo), "-output", binary], { stdio: "inherit" });
} else {
  fs.copyFileSync(cargo(null), binary);
}
fs.chmodSync(binary, 0o755);
if (process.platform === "darwin") bundle();
fs.mkdirSync(path.dirname(stamp), { recursive: true });
fs.writeFileSync(stamp, hash);
console.log(`[openlive-cu] ${path.relative(root, out)}`);

function bundle() {
  const contents = path.join(out, "Contents");
  const resources = path.join(contents, "Resources");
  fs.mkdirSync(resources, { recursive: true });
  const icon = path.join(root, "..", "..", "apps", "desktop", "build", "icon.png");
  // An icon is what System Settings shows next to the grant; without sips the generic one is fine.
  const hasIcon = spawnSync("sips", ["-s", "format", "icns", icon, "--out", path.join(resources, "AppIcon.icns")], { stdio: "ignore" }).status === 0;
  const { version } = JSON.parse(fs.readFileSync(path.join(root, "..", "..", "package.json"), "utf8"));
  fs.writeFileSync(path.join(contents, "Info.plist"), infoPlist(version, hasIcon));
  const identity = process.env.OPENLIVE_CU_SIGN_IDENTITY || process.env.CSC_NAME || "-";
  const args = ["--force", "--sign", identity];
  if (identity !== "-") args.push("--options", "runtime", "--timestamp", "--entitlements", path.join(root, "entitlements.mac.plist"));
  const signed = spawnSync("codesign", [...args, out], { stdio: "inherit" });
  if (signed.status !== 0) throw new Error(`[openlive-cu] codesign with "${identity}" failed`);
}

function infoPlist(version, hasIcon) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const entries = {
    CFBundleDevelopmentRegion: "en",
    CFBundleExecutable: exe,
    CFBundleIdentifier: BUNDLE_ID,
    CFBundleInfoDictionaryVersion: "6.0",
    CFBundleName: "OpenLive Computer Use",
    CFBundleDisplayName: "OpenLive Computer Use",
    CFBundlePackageType: "APPL",
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
    ...(hasIcon && { CFBundleIconFile: "AppIcon" }),
    // OpenLive's own floor; window pictures need 14 and say so below that.
    LSMinimumSystemVersion: "13.0",
    NSAccessibilityUsageDescription: "OpenLive Computer Use reads and operates app windows when you ask OpenLive to use an app.",
    NSScreenCaptureUsageDescription: "OpenLive Computer Use takes pictures of app windows when you ask OpenLive to look at or use an app.",
  };
  const body = Object.entries(entries).map(([k, v]) => `  <key>${k}</key>\n  <string>${esc(v)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
`;
}
