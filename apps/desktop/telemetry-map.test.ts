import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const map = require("./telemetry-map.cjs");
const schema = require("./telemetry/schema.json");
const { validateCommon, validateEvent } = require("./telemetry/validate.cjs");

const values = (event: string, prop: string): string[] => schema.events[event].props[prop].values;

describe("osMajor", () => {
  it("is the macOS major, however the version is written", () => {
    expect(map.osMajor("darwin", "15.6.1", "24.6.0")).toBe("15");
    expect(map.osMajor("darwin", "26.0", "25.0.0")).toBe("26");
    expect(map.osMajor("darwin", "26", "")).toBe("26");
    expect(map.osMajor("darwin", "", "")).toBe("");
  });
  it("tells Windows 10 from 11 by build number, since both report 10.0", () => {
    expect(map.osMajor("win32", "10.0.19045", "10.0.19045")).toBe("10");
    expect(map.osMajor("win32", "10.0.21999", "10.0.21999")).toBe("10");
    expect(map.osMajor("win32", "10.0.22000", "10.0.22000")).toBe("11");
    expect(map.osMajor("win32", "10.0.26100", "10.0.26100")).toBe("11");
    expect(map.osMajor("win32", "10.0", "10.0")).toBe("");
  });
  it("is linux on every other platform and never a distro", () => {
    expect(map.osMajor("linux", "", "6.8.0-45-generic")).toBe("linux");
    expect(map.osMajor("freebsd", "", "14.0")).toBe("linux");
  });
  it("always passes the common-property validator or is empty", () => {
    for (const v of [map.osMajor("darwin", "15.1", ""), map.osMajor("win32", "", "10.0.22631"), map.osMajor("linux", "", "6.8")]) {
      expect(validateCommon({ os_major: v }).os_major).toBe(v);
    }
  });
});

describe("updaterErrorKind", () => {
  const kind = (e: unknown) => map.updaterErrorKind(e);
  it("maps updater codes to a few classes", () => {
    expect(kind({ code: "ERR_UPDATER_LATEST_VERSION_NOT_FOUND" })).toBe("feed_missing");
    expect(kind({ code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" })).toBe("feed_missing");
    expect(kind({ code: "ERR_UPDATER_ASSET_NOT_FOUND" })).toBe("asset_missing");
    expect(kind({ code: "ERR_UPDATER_BLOCKMAP_FILE_NOT_FOUND" })).toBe("asset_missing");
    expect(kind({ code: "ERR_UPDATER_INVALID_SIGNATURE" })).toBe("signature_invalid");
    expect(kind({ code: "ERR_UPDATER_NO_CHECKSUM" })).toBe("signature_invalid");
  });
  it("calls transport codes network", () => {
    for (const code of ["HTTP_ERROR_503", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ENETUNREACH"]) {
      expect(kind({ code })).toBe("network");
    }
  });
  it("calls a Chromium network error network, which carries no code", () => {
    expect(kind(new Error("net::ERR_INTERNET_DISCONNECTED"))).toBe("network");
  });
  it("keeps everything else, including anything odd, as other", () => {
    expect(kind({ code: "ERR_UPDATER_INVALID_VERSION" })).toBe("other");
    expect(kind(new Error("something at /Users/someone/app.asar failed"))).toBe("other");
    expect(kind({ code: 42, message: 7 })).toBe("other");
    for (const odd of [null, undefined, "ERR_UPDATER_ASSET_NOT_FOUND", 5]) expect(kind(odd)).toBe("other");
  });
  it("answers with exactly the values the schema lists, so none of them is dead", () => {
    const seen = [
      { code: "ERR_UPDATER_LATEST_VERSION_NOT_FOUND" }, { code: "ERR_UPDATER_ASSET_NOT_FOUND" }, { code: "ERR_UPDATER_INVALID_SIGNATURE" },
      { code: "HTTP_ERROR_500" }, new Error("net::x"), null,
    ].map(kind);
    expect([...new Set(seen)].sort()).toEqual([...values("update_result", "error_kind")].sort());
  });
});

describe("crash mapping", () => {
  it("does not count a clean exit and reads an unknown reason as abnormal", () => {
    expect(map.crashReason("clean-exit")).toBeNull();
    expect(map.crashReason("crashed")).toBe("crashed");
    expect(map.crashReason("oom")).toBe("oom");
    expect(map.crashReason("something-new")).toBe("abnormal-exit");
    expect(map.crashReason(undefined)).toBe("abnormal-exit");
    const mapped = ["crashed", "oom", "killed", "abnormal-exit", "launch-failed", "integrity-failure", "memory-eviction"].map(map.crashReason);
    expect([...mapped, "unclean_exit"].sort()).toEqual([...values("crash_detected", "reason")].sort());
  });
  it("keeps only exit codes the schema takes", () => {
    expect(map.exitCode(0)).toBe(0);
    expect(map.exitCode(139)).toBe(139);
    expect(map.exitCode(999)).toBe(999);
    expect(map.exitCode(1000)).toBe(-1);
    expect(map.exitCode(3221225477)).toBe(-1); // a Windows access violation
    expect(map.exitCode(-1073741819)).toBe(-1);
    expect(map.exitCode(null)).toBe(-1);
    expect(map.exitCode(1.5)).toBe(-1);
  });
  it("names the GPU process and folds every other helper into utility", () => {
    expect(map.childSource("GPU")).toBe("gpu");
    for (const type of ["Utility", "Zygote", "Sandbox helper", "Pepper Plugin", "Unknown", undefined]) {
      expect(map.childSource(type)).toBe("utility");
    }
    for (const type of ["GPU", "Utility"]) expect(values("crash_detected", "source")).toContain(map.childSource(type));
  });
  it("names the window by identity, and the cursor overlay by its page", () => {
    const main = { getURL: () => "http://localhost:47824/" };
    const owner = { getURL: () => "http://localhost:47824/flow-owner" };
    const overlay = { getURL: () => "file:///Applications/OpenLive.app/Contents/Resources/app.asar/flow-cursor.html?x=1" };
    const stranger = { getURL: () => "http://localhost:47824/other" };
    const windows = { main_window: main, flow_owner: owner, flow_orb: null, splash: undefined };
    expect(map.renderTarget(main, windows)).toBe("main_window");
    expect(map.renderTarget(owner, windows)).toBe("flow_owner");
    expect(map.renderTarget(overlay, windows)).toBe("cursor_overlay");
    expect(map.renderTarget(stranger, windows)).toBe("other");
    expect(map.renderTarget({ getURL: () => { throw new Error("destroyed"); } }, windows)).toBe("other");
    expect(map.renderTarget(undefined, windows)).toBe("other");
    for (const wc of [main, owner, overlay, stranger]) expect(values("crash_detected", "target")).toContain(map.renderTarget(wc, windows));
  });
});

describe("linuxSession", () => {
  it("reads the orb's pointer mode as the display server, and is n/a off Linux", () => {
    expect(map.linuxSession("linux", "solid")).toBe("wayland");
    expect(map.linuxSession("linux", "poll")).toBe("x11");
    expect(map.linuxSession("darwin", "forward")).toBe("n/a");
    expect(map.linuxSession("win32", "forward")).toBe("n/a");
    for (const s of [map.linuxSession("linux", "solid"), map.linuxSession("linux", "poll"), map.linuxSession("darwin", "forward")]) {
      expect(values("app_launch", "linux_session")).toContain(s);
    }
  });
});

describe("permissionFacts", () => {
  it("names the grants as the schema does", () => {
    const facts = map.permissionFacts({ accessibility: true, postEvents: false, microphone: "denied", screenRecording: true, extra: "ignored" });
    expect(facts).toEqual({ perm_accessibility: true, perm_post_events: false, perm_screen: true, perm_microphone: "denied" });
    expect(validateEvent("flow_readiness_changed", { from: "unknown", to: "access", ...facts })).toMatchObject(facts);
  });
  it("says unknown for a microphone state it does not know, and nothing when the addon said nothing", () => {
    expect(map.permissionFacts({ microphone: "weird" }).perm_microphone).toBe("unknown");
    expect(map.permissionFacts(undefined)).toEqual({});
    expect(map.permissionFacts(null)).toEqual({});
  });
});

describe("permission requests", () => {
  it("renames postEvents and drops anything the addon does not know", () => {
    expect(map.permissionName("postEvents")).toBe("post_events");
    expect(map.permissionName("accessibility")).toBe("accessibility");
    expect(map.permissionName("microphone")).toBe("microphone");
    expect(map.permissionName("screen")).toBe("screen");
    expect(map.permissionName("toString")).toBeUndefined();
    expect(map.permissionName({})).toBeUndefined();
    for (const what of ["accessibility", "microphone", "screen", "postEvents"]) {
      expect(values("os_permission_request", "permission")).toContain(map.permissionName(what));
    }
  });
  it("reads the microphone's status string and every other answer as a boolean", () => {
    expect(map.permissionGranted("microphone", "granted")).toBe(true);
    expect(map.permissionGranted("microphone", "denied")).toBe(false);
    expect(map.permissionGranted("microphone", true)).toBe(false);
    expect(map.permissionGranted("accessibility", true)).toBe(true);
    expect(map.permissionGranted("screen", false)).toBe(false);
    expect(map.permissionGranted("postEvents", "granted")).toBe(false);
  });
  it("keeps only the screens the schema names", () => {
    for (const from of values("os_permission_request", "asked_from")) expect(map.askedFrom(from)).toBe(from);
    expect(map.askedFrom("orb_fix")).toBeUndefined();
    expect(map.askedFrom("a free-form string")).toBeUndefined();
    expect(map.askedFrom(undefined)).toBeUndefined();
    expect(map.askedFrom({ toString: () => "onboarding" })).toBeUndefined();
  });
});

describe("flowEndReason", () => {
  it("passes what the owner may say and reads everything else as other", () => {
    for (const reason of ["gesture", "orb_button", "idle", "disarmed", "sleep_or_lock", "other"]) expect(map.flowEndReason(reason)).toBe(reason);
    for (const bad of ["quit", "sleep", "", undefined, null, 7, {}, "GESTURE"]) expect(map.flowEndReason(bad)).toBe("other");
  });
  it("never answers with a value flow_session refuses", () => {
    for (const reason of ["gesture", "orb_button", "idle", "disarmed", "sleep_or_lock", "other", "quit", "x"]) {
      expect(values("flow_session", "ended_by")).toContain(map.flowEndReason(reason));
    }
  });
});

describe("powerSignal", () => {
  it("always tells the windows about sleep and wake", () => {
    for (const endOnLock of [true, false]) {
      expect(map.powerSignal("suspend", endOnLock)).toBe("suspend");
      expect(map.powerSignal("resume", endOnLock)).toBe("resume");
    }
  });
  it("ends Flow and calls on a lock, and lets them back on the unlock, while the setting is on", () => {
    expect(map.powerSignal("lock-screen", true)).toBe("suspend");
    expect(map.powerSignal("unlock-screen", true)).toBe("resume");
  });
  it("sends nothing for a lock or an unlock with the setting off", () => {
    expect(map.powerSignal("lock-screen", false)).toBeNull();
    expect(map.powerSignal("unlock-screen", false)).toBeNull();
  });
  it("sends nothing for an event it does not know, and reads only a true setting as on", () => {
    for (const event of ["shutdown", "on-ac", "", undefined, "toString", "__proto__"]) expect(map.powerSignal(event, true)).toBeNull();
    for (const off of [false, undefined, null, 0]) expect(map.powerSignal("lock-screen", off)).toBeNull();
  });
});
