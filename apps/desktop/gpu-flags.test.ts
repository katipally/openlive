import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const { ignoreGpuBlocklist } = createRequire(import.meta.url)("./gpu-flags.cjs");

describe("ignoreGpuBlocklist", () => {
  it("overrides the blocklist by default so WebGPU keeps working", () => {
    for (const platform of ["win32", "darwin", "linux"]) expect(ignoreGpuBlocklist({ platform, state: null, version: "0.3.1" })).toBe(true);
    expect(ignoreGpuBlocklist({ platform: "win32", state: {}, version: "0.3.1" })).toBe(true);
  });

  it("keeps the blocklist on Windows after a GPU crash on this version", () => {
    expect(ignoreGpuBlocklist({ platform: "win32", state: { crashedIn: "0.3.1" }, version: "0.3.1" })).toBe(false);
  });

  it("tries again on a newer version", () => {
    expect(ignoreGpuBlocklist({ platform: "win32", state: { crashedIn: "0.3.1" }, version: "0.3.2" })).toBe(true);
  });

  it("leaves other platforms alone", () => {
    expect(ignoreGpuBlocklist({ platform: "linux", state: { crashedIn: "0.3.1" }, version: "0.3.1" })).toBe(true);
  });
});
