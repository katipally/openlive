"use strict";
// electron-builder's beforePack: refuse to package an app without the ol-input
// addon for the platform and arch being packed, or a Mac or Windows build
// without the computer-use helper. Without it the installer still
// builds, and Flow is simply dead on the user's machine. Cross-packaging (say
// --win from a Mac) is caught here too: pack-native only builds for the host.
const fs = require("node:fs");
const path = require("node:path");
const { Arch } = require("electron-builder");

exports.default = async function checkNative({ electronPlatformName, arch }) {
  const platform = electronPlatformName === "mas" ? "darwin" : electronPlatformName;
  const binary = path.join(__dirname, "..", "dist", "ol-input", `ol-input.${platform}-${Arch[arch]}.node`);
  if (!fs.existsSync(binary)) {
    throw new Error(`[check-native] ${binary} is missing. Run \`pnpm --filter @openlive/desktop pack:native\` on a ${platform} ${Arch[arch]} machine before packaging.`);
  }
  const staged = path.join(__dirname, "..", "dist", "computer-use");
  const helper = {
    darwin: path.join(staged, "OpenLive Computer Use.app", "Contents", "MacOS", "openlive-cu"),
    win32: path.join(staged, "openlive-cu.exe"),
  }[platform];
  if (helper && !fs.existsSync(helper)) {
    throw new Error(`[check-native] ${helper} is missing. Run \`pnpm --filter @openlive/desktop pack:native\` before packaging.`);
  }
};
