"use strict";
// Stamp apps/desktop/release-build.json, the mark of a build the release workflow made. Only a
// release build is signed with the release identity, so only it can install an update; a local
// build that updates itself downloads the release into the installed app's caches and then
// fails signature validation. Without OPENLIVE_RELEASE_BUILD=1 a stale mark is removed.
const fs = require("node:fs");
const path = require("node:path");

const FILE = path.resolve(__dirname, "..", "release-build.json");

/** Returns whether the build was marked. */
function mark(env = process.env, file = FILE) {
  fs.rmSync(file, { force: true });
  if (env.OPENLIVE_RELEASE_BUILD !== "1") return false;
  fs.writeFileSync(file, "{}\n");
  return true;
}

if (require.main === module) {
  console.log(mark() ? "[pack-release-marker] marked as a release build" : "[pack-release-marker] local build: auto-update stays off");
}

module.exports = { mark, FILE };
