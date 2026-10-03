import { describe, expect, it } from "vitest";
import { addonProblem, deriveFailure, forOrb, keyListenerNote, sessionModelsOffer, modelsDownloading, modelsFailed, turnFailure, type FlowHealth } from "./failure";
import { IDLE_FLOW } from "./types";

const HEALTHY: FlowHealth = {
  platform: "darwin", accessibility: true, secureInput: false,
  hookError: null, addonError: null, packaged: false, brainReady: true, online: true, modelsCached: true, voiceModels: ["speech recognition", "voice", "turn-taking"], downloadBytes: 0,
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

  it("asks before the download, naming what it fetches, how big and where it is kept", () => {
    const missing = { ...HEALTHY, modelsCached: false, downloadBytes: 212_400_000 };
    const offer = deriveFailure(missing);
    expect(offer?.detail).toContain("need the speech recognition, voice and turn-taking models once, about 212 MB.");
    expect(offer?.detail).toContain("OpenLive's storage on this device");
    expect(offer?.actionLabel).toBe("Download");
    expect(deriveFailure({ ...missing, voiceModels: ["turn-taking"], downloadBytes: 1.6e9 })?.detail).toContain("need the turn-taking model once, about 1.6 GB.");
    expect(deriveFailure({ ...missing, downloadBytes: null })?.detail).toContain("turn-taking models once. ");
  });

  it("names a missing key or agent before the download it would otherwise offer", () => {
    expect(deriveFailure({ ...HEALTHY, modelsCached: false, brainReady: false })?.code).toBe("no_provider");
  });

  it("shows the download's progress with nothing to press, and a failure that tries again", () => {
    const going = modelsDownloading(53_000_000, 212_000_000);
    expect(going.detail).toMatch(/^25% of about 212 MB/);
    expect(going.actionLabel).toBeUndefined();
    expect(modelsFailed(true)).toMatchObject({ code: "models_missing", title: "The download stopped", actionLabel: "Try again" });
    expect(modelsFailed(false).title).toBe("You are offline");
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

  it("reads the wire code before the words, so a reworded message cannot change the card", () => {
    expect(turnFailure("The provider said something new", false, "auth")).toMatchObject({ code: "brain_setup", settings: "models" });
    expect(turnFailure("The provider said something new", true, "auth").settings).toBe("agents");
    expect(turnFailure("The provider said something new", false, "no_key").title).toBe("Your API key is missing");
    expect(turnFailure("x", false, "model_not_found")).toMatchObject({ code: "brain_setup", settings: "models" });
    expect(turnFailure("x", true, "no_model").settings).toBe("flow");
    expect(turnFailure("x", false, "quota").title).toContain("credit");
    expect(turnFailure("x", false, "rate_limited").title).toContain("busy");
    expect(turnFailure("x", false, "unreachable").title).toContain("reach");
  });

  it("trusts the code over words that say otherwise", () => {
    expect(turnFailure("HTTP 401: invalid x-api-key", false, "rate_limited").title).toContain("busy");
    expect(turnFailure("HTTP 429: rate limit", false, "server_error").title).toBe("That turn failed");
  });

  it("gives a plain card for a class with no fix of its own", () => {
    for (const code of ["server_error", "bad_request", "stream_error", "other", "agent_crashed", "agent_refused"] as const) {
      const f = turnFailure("it broke", false, code);
      expect(f).toMatchObject({ code: "turn_failed", detail: "it broke" });
      expect(f.actionLabel).toBeUndefined();
    }
  });

  it("never shows an empty card", () => {
    expect(turnFailure("   ").detail).toBeTruthy();
    expect(turnFailure("agent died").detail).toBe("agent died");
  });
});

describe("keyListenerNote", () => {
  it("is empty while the double tap can work", () => {
    expect(keyListenerNote(null, "flow")).toBe("");
    expect(keyListenerNote({ hookError: null, wayland: false }, "dictate")).toBe("");
  });
  it("passes on why the listener stopped before anything about the session", () => {
    const denied = "permission denied opening 3 device node(s) under /dev/input";
    expect(keyListenerNote({ hookError: denied, wayland: true }, "flow")).toContain(denied);
  });
  it("names the Wayland limit", () => {
    expect(keyListenerNote({ hookError: null, wayland: true }, "flow")).toMatch(/Wayland/);
  });
  it("names the mode whose screen it is on, and neither on a shared one", () => {
    const stopped = { hookError: "it died", wayland: false };
    expect(keyListenerNote(stopped, "flow")).toMatch(/^Flow's key listener/);
    expect(keyListenerNote(stopped, "dictate")).toMatch(/^Dictate's key listener/);
    expect(keyListenerNote(stopped, "shared")).toMatch(/^OpenLive's key listener/);
    expect(keyListenerNote({ hookError: null, wayland: true }, "dictate")).not.toMatch(/Flow/);
  });
});

describe("sessionModelsOffer", () => {
  const ask = { name: "the Supertonic voice", meanwhile: "Until then, replies keep the Kokoro voice." };
  it("asks with the size and what happens meanwhile, and downloading has nothing to press", () => {
    expect(sessionModelsOffer(ask, 400e6)).toMatchObject({ code: "models_missing", title: "Download the Supertonic voice?", actionLabel: "Download" });
    expect(sessionModelsOffer(ask, 400e6).detail).toMatch(/^Downloaded once, about 400 MB\. Until then, replies keep the Kokoro voice\./);
    expect(sessionModelsOffer(ask, null).detail).not.toMatch(/about/);
    expect(sessionModelsOffer(ask, null, true).actionLabel).toBeUndefined();
  });
});

describe("addonProblem", () => {
  it("never names Flow on Dictate's screens", () => {
    for (const packaged of [true, false]) {
      const { title, detail } = addonProblem(packaged, "dictate");
      expect(`${title} ${detail}`).not.toMatch(/Flow/);
      expect(title).toMatch(/^Dictate/);
      expect(addonProblem(packaged, "flow").title).toMatch(/^Flow/);
      expect(addonProblem(packaged, "shared").title).toMatch(/^OpenLive/);
    }
  });
});

describe("forOrb", () => {
  const failure = deriveFailure({ ...HEALTHY, brainReady: false })!;
  const dictating = { ...IDLE_FLOW, failure, dictate: { phase: "idle" as const, editing: false, partial: "", polishing: false, inserted: 3, note: "", undo: true, ready: true } };

  it("shows Flow's failure while Flow is open", () => {
    expect(forOrb(dictating, true).failure).toBe(failure);
  });

  it("never shows it on Dictate's orb with Flow closed, during the session or as it goes", () => {
    expect(forOrb(dictating, false)).toEqual({ ...dictating, failure: null });
    expect(forOrb({ ...dictating, dictate: null }, false).failure).toBeNull();
  });
});
