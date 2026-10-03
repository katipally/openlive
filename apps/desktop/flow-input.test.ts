import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** flow-input.cjs against stand-ins for electron and for the ol-input addon. */
function load(ownField?: () => unknown) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const stub = (path: string, exports: unknown) => {
    require.cache[path] = { id: path, filename: path, loaded: true, children: [], paths: [], path: "", exports } as unknown as NodeJS.Module;
  };
  const addon = {
    registerBinding: vi.fn(), suspendHook: vi.fn(), resumeHook: vi.fn(), notifyOpen: vi.fn(),
    initializeInjector: vi.fn(), initializeHook: vi.fn(), hookError: vi.fn(() => null), permissionStatus: vi.fn(() => ({})),
    secureInputStatus: vi.fn(() => ({ changed: false })), shutdown: vi.fn(),
    focusEditable: vi.fn(async () => null), beginInsertion: vi.fn(async () => 7), pushInsertion: vi.fn(async () => {}), endInsertion: vi.fn(async () => {}),
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
  flowInput.install(() => null, { reportOnboardingStep: vi.fn() }, ownField);
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

describe("typing into OpenLive's own window", () => {
  const own = () => ({ insertText: vi.fn(async () => {}), executeJavaScript: vi.fn(async () => true) });

  it("goes through Electron, not the addon, and a session keeps the window it began in", async () => {
    const wc = own();
    let focused: ReturnType<typeof own> | null = wc;
    const { addon, call } = load(() => focused);
    expect(await call("openlive:flow-focus-editable")).toEqual({ ok: true, value: true });
    const { value: session } = (await call("openlive:flow-insert-begin", "paste", {})) as { value: number };
    await call("openlive:flow-insert-push", session, "Running five");
    focused = null;
    await call("openlive:flow-insert-push", session, " minutes late");
    expect(await call("openlive:flow-insert-end", session)).toEqual({ ok: true, value: undefined });
    expect(wc.insertText.mock.calls).toEqual([["Running five"], [" minutes late"]]);
    expect(addon.focusEditable).not.toHaveBeenCalled();
    expect(addon.beginInsertion).not.toHaveBeenCalled();
    expect(addon.pushInsertion).not.toHaveBeenCalled();
    expect(addon.endInsertion).not.toHaveBeenCalled();
  });

  it("types nothing with no text box in focus, and fails so the caller copies instead", async () => {
    const wc = { insertText: vi.fn(async () => {}), executeJavaScript: vi.fn(async () => false) };
    const { addon, call } = load(() => wc);
    expect(await call("openlive:flow-focus-editable")).toEqual({ ok: true, value: false });
    expect(await call("openlive:flow-insert-begin", "paste", {})).toEqual({ ok: false, error: "No text box in focus." });
    expect(wc.insertText).not.toHaveBeenCalled();
    expect(addon.beginInsertion).not.toHaveBeenCalled();
  });

  it("asks the page for a field that takes input, not a disabled or read-only one", async () => {
    const wc = own();
    const { call } = load(() => wc);
    await call("openlive:flow-insert-begin", "paste", {});
    const [script] = wc.executeJavaScript.mock.calls[0] as unknown as [string];
    const editable = (activeElement: unknown) => new Function("document", `return ${script}`)({ activeElement }) as boolean;
    const input = (o: object) => ({ tagName: "INPUT", type: "text", disabled: false, readOnly: false, ...o });
    expect(editable(input({}))).toBe(true);
    expect(editable({ tagName: "TEXTAREA", disabled: false, readOnly: false })).toBe(true);
    expect(editable({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(editable(input({ disabled: true }))).toBe(false);
    expect(editable(input({ readOnly: true }))).toBe(false);
    expect(editable({ tagName: "TEXTAREA", disabled: false, readOnly: true })).toBe(false);
    expect(editable(input({ type: "checkbox" }))).toBe(false);
    expect(editable({ tagName: "BUTTON" })).toBe(false);
    expect(editable(null)).toBe(false);
  });

  it("leaves every other app to the addon", async () => {
    const { addon, call } = load(() => null);
    expect(await call("openlive:flow-focus-editable")).toEqual({ ok: true, value: null });
    const { value: session } = (await call("openlive:flow-insert-begin", "type", {})) as { value: number };
    await call("openlive:flow-insert-push", session, "hi");
    await call("openlive:flow-insert-end", session);
    expect(addon.pushInsertion).toHaveBeenCalledWith(7, "hi");
    expect(addon.endInsertion).toHaveBeenCalledWith(7);
  });
});
