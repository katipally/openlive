"use strict";
// Whether to override Chromium's GPU blocklist. Pure, so the rule tests without Electron.

/**
 * The blocklist is overridden so WebGPU runs the on-device voice models on cards
 * Chromium distrusts. On Windows that forced a driver that then crashed the GPU
 * process, so once one did, this app version stops overriding it and those cards
 * fall back to the CPU. The next version tries again, since drivers get fixed.
 * `state` is what the last run saved: { crashedIn: appVersion }.
 */
function ignoreGpuBlocklist({ platform, state, version }) {
  return !(platform === "win32" && state?.crashedIn === version);
}

module.exports = { ignoreGpuBlocklist };
