"use strict";

/** Why the auto-updater must not run, or null when it may. `releaseBuild` is whether pack-release-marker.cjs marked this build. */
function updatesOffReason({ env, releaseBuild }) {
  if (env.OPENLIVE_NO_UPDATES === "1") return "OPENLIVE_NO_UPDATES is set.";
  if (!releaseBuild) return "This is a local build, which can't install a release.";
  return null;
}

module.exports = { updatesOffReason };
