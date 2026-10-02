import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const { loginDefaultReady } = createRequire(import.meta.url)("./login-item.cjs");

describe("loginDefaultReady", () => {
  it("waits on macOS until the app runs from an Applications folder", () => {
    expect(loginDefaultReady({ platform: "darwin", inApplications: true })).toBe(true);
    expect(loginDefaultReady({ platform: "darwin", inApplications: false })).toBe(false);
  });

  it("waits on Linux while the AppImage sits in the downloads folder", () => {
    const downloads = "/home/ana/Downloads";
    expect(loginDefaultReady({ platform: "linux", exe: "/home/ana/Downloads/OpenLive-0.3.0-linux.AppImage", downloads })).toBe(false);
    expect(loginDefaultReady({ platform: "linux", exe: "/home/ana/Downloads/apps/OpenLive.AppImage", downloads })).toBe(false);
    expect(loginDefaultReady({ platform: "linux", exe: "/home/ana/Applications/OpenLive.AppImage", downloads })).toBe(true);
    expect(loginDefaultReady({ platform: "linux", exe: "/home/ana/Downloads-old/OpenLive.AppImage", downloads })).toBe(true);
    expect(loginDefaultReady({ platform: "linux", exe: "/opt/OpenLive/openlive", downloads: "" })).toBe(true);
  });

  it("applies on Windows, whose only package is the installer", () => {
    expect(loginDefaultReady({ platform: "win32", exe: "C:\\Users\\ana\\AppData\\Local\\Programs\\OpenLive\\OpenLive.exe" })).toBe(true);
  });
});
