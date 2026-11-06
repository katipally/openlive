"use strict";
// Why Flow's key listener cannot read the keyboard on Linux, found before it is
// armed. The listener reads /dev/input/event*, which only the input group (or a
// udev rule) may open, on X11 and Wayland alike. Opening a device read-only
// reads nothing from it, so the probe is side-effect free.
const fs = require("node:fs");
const os = require("node:os");

const DEVICES = "/dev/input";
const DENIED = new Set(["EACCES", "EPERM"]);

/** A closed set, so it is also what telemetry sends. */
const STATUSES = ["ok", "not_in_group", "needs_relogin", "no_devices", "sandboxed", "other"];

/**
 * @param {{ sandboxed: boolean, devices: { gid: number, error: string | null }[], processGroups: number[], memberOf: (gid: number) => boolean }} s
 *  `devices` are the event nodes tried, in order, stopping at the first that opens.
 *  `memberOf` is whether the account database lists the user in that group.
 */
function classify({ sandboxed, devices, processGroups, memberOf }) {
  if (devices.some((d) => !d.error)) return "ok";
  if (sandboxed) return "sandboxed";
  if (!devices.length) return "no_devices";
  if (!devices.every((d) => DENIED.has(d.error))) return "other";
  const gid = devices[0].gid;
  if (processGroups.includes(gid)) return "other";
  return memberOf(gid) ? "needs_relogin" : "not_in_group";
}

/** Flatpak and Snap hide or deny /dev/input; an AppImage runs unsandboxed. */
const sandboxed = () => fs.existsSync("/.flatpak-info") || !!process.env.SNAP;

function memberOf(gid) {
  try {
    const user = os.userInfo().username;
    return fs.readFileSync("/etc/group", "utf8").split("\n").some((line) => {
      const [, , id, members = ""] = line.split(":");
      return Number(id) === gid && members.split(",").includes(user);
    });
  } catch { return false; }
}

/** O(devices) at worst, and one open when access works. */
function probe() {
  const devices = [];
  let names = [];
  try { names = fs.readdirSync(DEVICES).filter((n) => /^event\d+$/.test(n)); } catch { /* absent or hidden */ }
  for (const name of names) {
    const file = `${DEVICES}/${name}`;
    try {
      const { gid } = fs.statSync(file);
      let error = null;
      try { fs.closeSync(fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)); } catch (e) { error = e.code || "unknown"; }
      devices.push({ gid, error });
      if (!error) break;
    } catch { /* unplugged between the listing and the stat */ }
  }
  return classify({ sandboxed: sandboxed(), devices, processGroups: [process.getgid(), ...process.getgroups()], memberOf });
}

let cached = null;

/** Read once per session; `fresh` asks again, for "Check again" after the user ran the fix. Null off Linux. */
function inputAccess(fresh = false) {
  if (process.platform !== "linux") return null;
  if (fresh || cached === null) cached = probe();
  return cached;
}

module.exports = { STATUSES, classify, inputAccess };
