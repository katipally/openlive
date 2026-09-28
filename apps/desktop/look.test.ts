import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const { osHasGlass, gpuComposites, glassSupport, effectiveLook } = createRequire(import.meta.url)("./look.cjs");

const mac = { platform: "darwin", release: "25.0.0", gpuCompositing: "enabled", reducedTransparency: false, slow: false };

describe("osHasGlass", () => {
  it("is macOS and Windows 11 22H2 and later only", () => {
    expect(osHasGlass("darwin", "25.0.0")).toBe(true);
    expect(osHasGlass("win32", "10.0.22621")).toBe(true);
    expect(osHasGlass("win32", "10.0.26100")).toBe(true);
    expect(osHasGlass("win32", "10.0.22000")).toBe(false); // Windows 11 21H2
    expect(osHasGlass("win32", "10.0.19045")).toBe(false); // Windows 10
    expect(osHasGlass("win32", "")).toBe(false);
    expect(osHasGlass("linux", "6.8.0")).toBe(false);
  });
});

describe("gpuComposites", () => {
  it("reads every enabled flavour as on and anything else as off", () => {
    expect(gpuComposites("enabled")).toBe(true);
    expect(gpuComposites("enabled_on")).toBe(true);
    expect(gpuComposites("disabled_software")).toBe(false);
    expect(gpuComposites("unavailable_off")).toBe(false);
    expect(gpuComposites(undefined)).toBe(false);
  });
});

describe("glassSupport", () => {
  it("supports a plain Mac", () => {
    expect(glassSupport(mac)).toEqual({ supported: true, reason: null });
  });
  it("names each reason", () => {
    expect(glassSupport({ ...mac, reducedTransparency: true }).reason).toBe("reduce-transparency");
    expect(glassSupport({ ...mac, gpuCompositing: "disabled_software" }).reason).toBe("no-gpu");
    expect(glassSupport({ ...mac, slow: true }).reason).toBe("slow");
    expect(glassSupport({ ...mac, platform: "linux" }).reason).toBe("unsupported-os");
    expect(glassSupport({ ...mac, platform: "win32", release: "10.0.19045" }).reason).toBe("unsupported-os");
  });
  it("gives the reason nobody can change first", () => {
    const all = { platform: "linux", release: "6.8.0", gpuCompositing: "disabled_off", reducedTransparency: true, slow: true };
    expect(glassSupport(all).reason).toBe("unsupported-os");
    expect(glassSupport({ ...all, platform: "darwin" }).reason).toBe("no-gpu");
    expect(glassSupport({ ...all, platform: "darwin", gpuCompositing: "enabled" }).reason).toBe("reduce-transparency");
  });
});

describe("effectiveLook", () => {
  const yes = { supported: true, reason: null };
  const no = { supported: false, reason: "reduce-transparency" };
  it("defaults to glass where it can run and flat where it cannot", () => {
    expect(effectiveLook(null, yes)).toBe("glass");
    expect(effectiveLook(undefined, no)).toBe("flat");
  });
  it("keeps a saved choice, and falls back from glass without losing it", () => {
    expect(effectiveLook("flat", yes)).toBe("flat");
    expect(effectiveLook("glass", yes)).toBe("glass");
    expect(effectiveLook("glass", no)).toBe("flat");
  });
});
