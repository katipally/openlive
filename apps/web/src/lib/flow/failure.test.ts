import { describe, expect, it } from "vitest";
import { deriveFailure, type FlowHealth } from "./failure";

const HEALTHY: FlowHealth = {
  platform: "darwin", wayland: false, accessibility: true, secureInput: false,
  hookError: null, brainReady: true, online: true, modelsCached: true,
};

describe("deriveFailure", () => {
  it("says nothing when everything works", () => {
    expect(deriveFailure(HEALTHY)).toBeNull();
  });

  it("never reports a permission it could not read as denied", () => {
    expect(deriveFailure({ ...HEALTHY, accessibility: null })).toBeNull();
  });

  it("reports the most blocking truth first", () => {
    const broken = { ...HEALTHY, hookError: "tap died", accessibility: false, brainReady: false, online: false };
    expect(deriveFailure(broken)?.code).toBe("hook_failed");
    expect(deriveFailure({ ...broken, hookError: null })?.code).toBe("no_accessibility");
  });

  it("gives every state a cause, and an action wherever one exists", () => {
    const cases: [Partial<FlowHealth>, string][] = [
      [{ accessibility: false }, "no_accessibility"],
      [{ wayland: true }, "wayland"],
      [{ secureInput: true }, "secure_input"],
      [{ brainReady: false }, "no_provider"],
      [{ online: false }, "offline"],
      [{ modelsCached: false }, "models_missing"],
    ];
    for (const [patch, code] of cases) {
      const f = deriveFailure({ ...HEALTHY, ...patch });
      expect(f?.code).toBe(code);
      expect(f?.title).toBeTruthy();
      expect(f?.detail).toBeTruthy();
    }
  });
});
