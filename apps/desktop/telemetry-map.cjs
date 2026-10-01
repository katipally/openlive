"use strict";
// Closed-set mappers between what Electron, the OS and a renderer hand main and the
// enums in telemetry/schema.json. Pure, so tests can load them. Each one reads a code,
// a name or a number, never text a person wrote.

/** The first Windows 11 build. */
const WIN11_BUILD = 22000;

/** "15" for macOS 15, "10" or "11" for Windows by build number, "linux" for the rest, "" when unreadable.
 *  `systemVersion` is process.getSystemVersion(), `release` is os.release(). Never the distro. */
function osMajor(platform, systemVersion, release) {
  if (platform === "darwin") return /^(\d{1,2})(\.|$)/.exec(String(systemVersion))?.[1] ?? "";
  if (platform !== "win32") return "linux";
  const build = Number(String(release).split(".")[2]);
  return Number.isFinite(build) ? (build >= WIN11_BUILD ? "11" : "10") : "";
}

const FEED_MISSING = new Set([
  "ERR_UPDATER_LATEST_VERSION_NOT_FOUND", "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
  "ERR_UPDATER_RELEASE_NOT_FOUND", "ERR_UPDATER_NO_PUBLISHED_VERSIONS",
]);
const ASSET_MISSING = new Set([
  "ERR_UPDATER_ASSET_NOT_FOUND", "ERR_UPDATER_ZIP_FILE_NOT_FOUND",
  "ERR_UPDATER_BLOCKMAP_FILE_NOT_FOUND", "ERR_UPDATER_NO_FILES_PROVIDED",
]);
const SIGNATURE_INVALID = new Set(["ERR_UPDATER_INVALID_SIGNATURE", "ERR_UPDATER_NO_CHECKSUM"]);
const NETWORK_CODE = /^(HTTP_ERROR_\d+|E(CONN[A-Z]+|NOTFOUND|AI_AGAIN|TIMEDOUT|NETUNREACH|HOSTUNREACH|PIPE))$/;

/** The schema's `error_kind` for an updater error. Reads `code`; Chromium's own network errors carry none,
 *  so the one other thing looked at is whether the message starts with "net::". The message is never kept. */
function updaterErrorKind(e) {
  const code = typeof e?.code === "string" ? e.code : "";
  if (FEED_MISSING.has(code)) return "feed_missing";
  if (ASSET_MISSING.has(code)) return "asset_missing";
  if (SIGNATURE_INVALID.has(code)) return "signature_invalid";
  if (NETWORK_CODE.test(code)) return "network";
  return typeof e?.message === "string" && e.message.startsWith("net::") ? "network" : "other";
}

const CRASH_REASONS = new Set(["crashed", "oom", "killed", "abnormal-exit", "launch-failed", "integrity-failure", "memory-eviction"]);

/** null for a clean exit, which is not a crash; a reason Electron adds later reads as an abnormal exit. */
const crashReason = (reason) => (reason === "clean-exit" ? null : CRASH_REASONS.has(reason) ? reason : "abnormal-exit");

/** An exit code as the schema takes it: 0 to 999, else -1 (a Windows status code or a signal does not fit). */
const exitCode = (code) => (Number.isInteger(code) && code >= 0 && code <= 999 ? code : -1);

/** Electron's child process type as a crash source: the GPU process, or a utility (any other helper). */
const childSource = (type) => (type === "GPU" ? "gpu" : "utility");

/** Which window a render process belonged to. `windows` maps a target name to its webContents (or null).
 *  The cursor overlay is told by its own page, since main keeps no handle to it. */
function renderTarget(wc, windows) {
  for (const [target, known] of Object.entries(windows)) if (known && known === wc) return target;
  try {
    return wc.getURL().split(/[?#]/)[0].endsWith("/flow-cursor.html") ? "cursor_overlay" : "other";
  } catch {
    return "other";
  }
}

/** The X11 or Wayland session, from the orb's pointer mode (orb-pointer.cjs): "solid" is Wayland's. */
const linuxSession = (platform, pointerMode) => (platform !== "linux" ? "n/a" : pointerMode === "solid" ? "wayland" : "x11");

const MIC_STATES = new Set(["granted", "denied", "undetermined", "restricted"]);

/** The permission grants behind a readiness state, named as the schema names them. {} when the addon said nothing. */
function permissionFacts(status) {
  if (!status || typeof status !== "object") return {};
  return {
    perm_accessibility: !!status.accessibility,
    perm_post_events: !!status.postEvents,
    perm_screen: !!status.screenRecording,
    perm_microphone: MIC_STATES.has(status.microphone) ? status.microphone : "unknown",
  };
}

const PERMISSIONS = { accessibility: "accessibility", microphone: "microphone", screen: "screen", postEvents: "post_events" };

/** The schema's name for a permission the addon knows by another, or undefined. */
const permissionName = (what) => (Object.hasOwn(PERMISSIONS, what) ? PERMISSIONS[what] : undefined);

/** Whether a permission prompt's answer means granted: the microphone answers with a status, the rest with a boolean. */
const permissionGranted = (what, answer) => (what === "microphone" ? answer === "granted" : answer === true);

const ASKED_FROM = new Set(["onboarding", "flow_settings", "flow_home", "other"]);

/** The screen a permission request came from, or undefined when a renderer names anything else. */
const askedFrom = (v) => (ASKED_FROM.has(v) ? v : undefined);

const FLOW_END_REASONS = new Set(["gesture", "orb_button", "idle", "disarmed", "sleep_or_lock", "other"]);

/** Why the owner renderer says Flow closed: one of the closed set, else "other". Main adds "disarmed" and "quit" itself. */
const flowEndReason = (v) => (FLOW_END_REASONS.has(v) ? v : "other");

const POWER_SIGNALS = { suspend: "suspend", resume: "resume", "lock-screen": "suspend", "unlock-screen": "resume" };
const LOCK_EVENTS = new Set(["lock-screen", "unlock-screen"]);

/** What the windows are told for a powerMonitor event, or null for nothing. Sleep and wake always go out; a lock
 *  and its unlock only while `endOnLock` is on, so a lock the person chose to ride out sends neither. */
const powerSignal = (event, endOnLock) => (!Object.hasOwn(POWER_SIGNALS, event) || (LOCK_EVENTS.has(event) && !endOnLock) ? null : POWER_SIGNALS[event]);

module.exports = {
  osMajor, updaterErrorKind, crashReason, exitCode, childSource, renderTarget, linuxSession,
  permissionFacts, permissionName, permissionGranted, askedFrom, flowEndReason, powerSignal,
};
