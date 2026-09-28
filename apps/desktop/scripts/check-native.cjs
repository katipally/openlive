"use strict";
// electron-builder's beforePack: refuse to package an app without the ol-input
// addon for the platform and arch being packed. Without it the installer still
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
};
