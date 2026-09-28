"use strict";
// Whether the Glass look can run, and which look a window gets. Pure, so the
// main process and its tests share one answer.

/** The first Windows 11 build with DWM system backdrops (22H2). */
const WIN_BACKDROP_BUILD = 22621;

/** `release` is os.release(): "10.0.22631" on Windows 11 23H2. */
function osHasGlass(platform, release) {
  if (platform === "darwin") return true;
  if (platform !== "win32") return false;
  const build = Number(String(release).split(".")[2]);
  return build >= WIN_BACKDROP_BUILD;
}

/** app.getGPUFeatureStatus().gpu_compositing is "enabled", "enabled_on" and the
 *  like when composited on the GPU; "disabled_software", "unavailable_off" and
 *  the like when not. */
const gpuComposites = (status) => String(status || "").startsWith("enabled");

/** { supported, reason } with the reason a person can least do something about
 *  first: no point asking them to change a setting on an OS that has no glass. */
function glassSupport({ platform, release, gpuCompositing, reducedTransparency, slow }) {
  const reason = !osHasGlass(platform, release) ? "unsupported-os"
    : !gpuComposites(gpuCompositing) ? "no-gpu"
    : reducedTransparency ? "reduce-transparency"
    : slow ? "slow"
    : null;
  return { supported: !reason, reason };
}

/** A saved choice stands while glass can run; with none saved, glass is the
 *  default wherever it can. Unsupported falls back to flat without touching
 *  what was saved, so it comes back when the reason goes away. */
function effectiveLook(saved, support) {
  if (!support.supported) return "flat";
  return saved === "flat" ? "flat" : "glass";
}

module.exports = { osHasGlass, gpuComposites, glassSupport, effectiveLook };
