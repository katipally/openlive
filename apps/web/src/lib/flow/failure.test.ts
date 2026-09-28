import { describe, expect, it } from "vitest";
import { deriveFailure, keyListenerNote, turnFailure, type FlowHealth } from "./failure";

const HEALTHY: FlowHealth = {
  platform: "darwin", accessibility: true, secureInput: false,
  hookError: null, addonError: null, packaged: false, brainReady: true, online: true, modelsCached: true, voiceModels: ["speech", "voice", "turn-taking"],
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
    expect(deriveFailure({ ...broken, addonError: "not built" })?.code).toBe("addon_missing");
  });

  it("tells a checkout to build the addon and an install to reinstall, without the raw loader error", () => {
    const raw = "ol-input native addon not built. Looked in: /repo/native/ol-input/ol-input.darwin-arm64.node";
    const dev = deriveFailure({ ...HEALTHY, addonError: raw });
    expect(dev?.detail).toContain("pnpm native:build");
    expect(dev?.detail).not.toContain("/repo");
    expect(dev?.actionLabel).toBeTruthy();
    expect(deriveFailure({ ...HEALTHY, addonError: raw, packaged: true })?.detail).toMatch(/Reinstall/);
  });

  it("gives every state a cause, and an action wherever one exists", () => {
    const cases: [Partial<FlowHealth>, string][] = [
      [{ accessibility: false }, "no_accessibility"],
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

  it("names the grant the way the platform does, and offers no trigger that does not exist", () => {
    expect(deriveFailure({ ...HEALTHY, accessibility: false })?.detail).toContain("Accessibility");
    expect(deriveFailure({ ...HEALTHY, platform: "win32", accessibility: false })?.detail).toContain("input access");
  });

  it("lets Wayland try the key listener, and on Linux says how to let it read the keyboard", () => {
    expect(deriveFailure({ ...HEALTHY, platform: "linux" })).toBeNull();
    const linux = deriveFailure({ ...HEALTHY, platform: "linux", hookError: "permission denied opening 3 device node(s) under /dev/input" });
    expect(linux?.code).toBe("hook_failed");
    expect(linux?.detail).toMatch(/input group/);
    expect(linux?.detail).toContain("usermod -aG input");
    expect(deriveFailure({ ...HEALTHY, platform: "win32", hookError: "tap died" })?.detail).toBe("tap died");
  });

  it("names the voice models the selected engines actually download", () => {
    const missing = { ...HEALTHY, modelsCached: false };
    expect(deriveFailure(missing)?.detail).toContain("needs the speech, voice and turn-taking models once");
    expect(deriveFailure({ ...missing, voiceModels: ["turn-taking"] })?.detail).toContain("needs the turn-taking model once");
  });
});

describe("turnFailure", () => {
  it("sends a missing, refused or unknown setting to where it is fixed", () => {
    const setup = [
      "No API key for OpenAI. Add one in Settings > Models.",
      'HTTP 401: {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      'HTTP 404: {"error":{"message":"model \\"qwen9\\" not found, try pulling it first"}}',
    ];
    for (const m of setup) {
      const f = turnFailure(m);
      expect(f.code).toBe("brain_setup");
      expect(f.actionLabel).toBeTruthy();
    }
  });

  it("opens the settings page the card's own words name", () => {
    expect(deriveFailure({ ...HEALTHY, brainReady: false })?.settings).toBe("flow");
    const key = turnFailure("No API key for OpenAI. Add one in Settings > Models.");
    expect(key.detail).toContain("Settings > Models");
    expect(key.settings).toBe("models");
    expect(turnFailure("HTTP 401: invalid x-api-key").settings).toBe("models");
    expect(turnFailure('HTTP 404: {"error":{"message":"model not found"}}').settings).toBe("models");
    // A coding agent signs in under Agents and has its model pinned in Flow.
    expect(turnFailure("Authentication required", true).settings).toBe("agents");
    expect(turnFailure("unknown model opus-9", true).settings).toBe("flow");
  });

  it("sends a model it could not reach at a named address to where the address is set", () => {
    const f = turnFailure("Could not reach Ollama (local) at http://nas:11434. Is it running?");
    expect(f.actionLabel).toBeTruthy();
    expect(f.settings).toBe("models");
  });

  it("has a page to open for every card whose button is a settings fix", () => {
    const withButton = [
      "No API key for OpenAI. Add one in Settings > Models.", "HTTP 403: forbidden", "HTTP 404: model not found",
      "Could not reach Ollama (local) at http://127.0.0.1:1. Is it running?",
    ];
    for (const agent of [false, true]) for (const m of withButton) expect(turnFailure(m, agent).settings).toBeTruthy();
  });

  it("reads the provider's own sentence out of a JSON error body", () => {
    expect(turnFailure('HTTP 404: {"error":{"message":"model \\"qwen9\\" not found"}}').detail).toBe('model "qwen9" not found. Pick another in settings.');
    expect(turnFailure('HTTP 401: {"error":{"message":"bad key"}}').detail).toBe("bad key");
  });

  it("offers no button for what only time or the provider can fix", () => {
    for (const m of ["HTTP 429: rate limit reached", "HTTP 429: You exceeded your current quota", "fetch failed", "Anthropic stream error: overloaded_error"]) {
      const f = turnFailure(m);
      expect(f.code).toBe("turn_failed");
      expect(f.actionLabel).toBeUndefined();
    }
    expect(turnFailure("fetch failed").detail).toContain("Ollama");
    expect(turnFailure("Could not reach Ollama (local) at http://nas:11434. Is it running?").detail).toBe("Could not reach Ollama (local) at http://nas:11434. Is it running?");
  });

  it("never shows an empty card", () => {
    expect(turnFailure("   ").detail).toBeTruthy();
    expect(turnFailure("agent died").detail).toBe("agent died");
  });
});

describe("keyListenerNote", () => {
  it("is empty while the double tap can work", () => {
    expect(keyListenerNote(null)).toBe("");
    expect(keyListenerNote({ hookError: null, wayland: false })).toBe("");
  });
  it("passes on why the listener stopped before anything about the session", () => {
    const denied = "permission denied opening 3 device node(s) under /dev/input";
    expect(keyListenerNote({ hookError: denied, wayland: true })).toContain(denied);
  });
  it("names the Wayland limit", () => {
    expect(keyListenerNote({ hookError: null, wayland: true })).toMatch(/Wayland/);
  });
});
