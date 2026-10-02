import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** flow-input.cjs against stand-ins for electron and for the ol-input addon. */
function load() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const stub = (path: string, exports: unknown) => {
    require.cache[path] = { id: path, filename: path, loaded: true, children: [], paths: [], path: "", exports } as unknown as NodeJS.Module;
  };
  const addon = {
    registerBinding: vi.fn(), suspendHook: vi.fn(), resumeHook: vi.fn(), notifyOpen: vi.fn(),
    initializeInjector: vi.fn(), initializeHook: vi.fn(), hookError: vi.fn(() => null), permissionStatus: vi.fn(() => ({})),
    secureInputStatus: vi.fn(() => ({ changed: false })), shutdown: vi.fn(),
  };
  stub(require.resolve("electron"), {
    app: { isPackaged: false, on: vi.fn() },
    ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn) },
    shell: {},
  });
  stub(require.resolve("../../native/ol-input"), addon);
  const mod = require.resolve("./flow-input.cjs");
  delete require.cache[mod];
  const flowInput = require(mod);
  flowInput.install(() => null, { reportOnboardingStep: vi.fn() });
  const call = (name: string, ...args: unknown[]) => handlers.get(name)!({}, ...args);
  return { flowInput, addon, call };
}

describe("typing at cursor's settings on their way to the addon", () => {
  it("carry the clipboard switch, both ways, and nothing else", () => {
    const { insertionTiming } = load().flowInput;
    expect(insertionTiming({ method: "paste", modifierHoldMs: 50, clipboardQuietMs: 200, clipboardTimeoutMs: 8000, restoreClipboard: false }))
      .toEqual({ modifierHoldMs: 50, clipboardQuietMs: 200, clipboardTimeoutMs: 8000, restoreClipboard: false });
    expect(insertionTiming({ restoreClipboard: true }).restoreClipboard).toBe(true);
    // Not a boolean: left out, so the addon keeps its own default (put it back).
    expect(insertionTiming({ restoreClipboard: "no" }).restoreClipboard).toBeUndefined();
  });
});

describe("Dictate's key", () => {
  it("is registered for holding, and Flow's only for its double-tap", async () => {
    const { addon, call } = load();
    await call("openlive:flow-register", "dictate", "option_right", true);
    await call("openlive:flow-register", "flow", "ctrl");
    expect(addon.registerBinding.mock.calls).toEqual([["dictate", "option_right", true], ["flow", "ctrl", false]]);
  });

  it("keeps working when Flow's own hotkey is switched off", async () => {
    const { flowInput, addon, call } = load();
    await call("openlive:flow-init");
    flowInput.setArmed(false);
    flowInput.setArmed(true);
    flowInput.teardown();
    expect(addon.suspendHook.mock.calls).toEqual([["flow"]]);
    expect(addon.resumeHook.mock.calls).toEqual([["flow"]]);
  });

  it("hears that hands-free was opened from the orb", async () => {
    const { addon, call } = load();
    await call("openlive:flow-gesture-open", "dictate", true);
    expect(addon.notifyOpen).toHaveBeenCalledWith("dictate", true);
  });
});
