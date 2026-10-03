import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** flow-input.cjs against stand-ins for electron and for the ol-input addon. */
function load(ownField?: () => unknown, { packaged = false } = {}) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const stub = (path: string, exports: unknown) => {
    require.cache[path] = { id: path, filename: path, loaded: true, children: [], paths: [], path: "", exports } as unknown as NodeJS.Module;
  };
  const addon = {
    registerBinding: vi.fn(), unregisterBinding: vi.fn(), suspendHook: vi.fn(), resumeHook: vi.fn(), triggerExternal: vi.fn(),
    narrowToggle: vi.fn((toggle: string, hold: string) => (toggle === "ctrl" && hold === "ctrl_right" ? "ctrl_left" : toggle)),
    initializeInjector: vi.fn(), initializeHook: vi.fn(), hookError: vi.fn(() => null), permissionStatus: vi.fn(() => ({})),
    secureInputStatus: vi.fn(() => ({ changed: false })), shutdown: vi.fn(),
    focusEditable: vi.fn(async () => null), accessibleSelection: vi.fn(async () => "the old line"), beginInsertion: vi.fn(async () => 7), pushInsertion: vi.fn(async () => {}), endInsertion: vi.fn(async () => {}),
  };
  stub(require.resolve("electron"), {
    app: { isPackaged: packaged, on: vi.fn() },
    ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn) },
    shell: {},
  });
  stub(require.resolve("../../native/ol-input"), addon);
  const mod = require.resolve("./flow-input.cjs");
  delete require.cache[mod];
  const flowInput = require(mod);
  const effects: unknown[] = [];
  flowInput.install((e: unknown) => effects.push(e), () => null, { reportOnboardingStep: vi.fn() }, ownField);
  const call = (name: string, ...args: unknown[]) => handlers.get(name)!({}, ...args);
  return { flowInput, addon, call, handlers, effects };
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

describe("the keys the settings ask for", () => {
  const KEYS = { flow: "ctrl", dictate: "option", ptt: "ctrl_right" };

  it("wait for the hook, then go on it with their roles", async () => {
    const { flowInput, addon, call } = load();
    flowInput.setBindings(KEYS);
    expect(addon.registerBinding).not.toHaveBeenCalled();
    await call("openlive:flow-init");
    expect(addon.registerBinding.mock.calls).toEqual([["flow", "ctrl", "toggle"], ["dictate", "option", "toggle"], ["ptt", "ctrl_right", "hold"]]);
  });

  it("change live, touching only what changed", async () => {
    const { flowInput, addon, call } = load();
    await call("openlive:flow-init");
    flowInput.setBindings(KEYS);
    addon.registerBinding.mockClear();
    flowInput.setBindings({ ...KEYS, ptt: null, dictate: "option_left" });
    expect(addon.unregisterBinding.mock.calls).toEqual([["dictate"], ["ptt"]]);
    expect(addon.registerBinding.mock.calls).toEqual([["dictate", "option_left", "toggle"]]);
  });

  it("are what the tray shows, with Flow's narrowed away from the push-to-talk key", async () => {
    const { flowInput, call } = load();
    await call("openlive:flow-init");
    flowInput.setBindings(KEYS);
    expect(flowInput.binding("flow")).toBe("ctrl_left");
    expect(flowInput.binding("ptt")).toBe("ctrl_right");
    flowInput.setBindings({ ...KEYS, ptt: null });
    expect(flowInput.binding("flow")).toBe("ctrl");
    expect(flowInput.binding("ptt")).toBeNull();
  });

  it("leave the other two working when one will not register", async () => {
    const { flowInput, addon, call } = load();
    addon.registerBinding.mockImplementation((id: string) => { if (id === "dictate") throw new Error("unknown key"); });
    await call("openlive:flow-init");
    flowInput.setBindings(KEYS);
    expect(flowInput.binding("flow")).toBe("ctrl_left");
    expect(flowInput.binding("dictate")).toBeNull();
  });

  it("go back on a hook that was started again", async () => {
    const { flowInput, addon, call } = load();
    flowInput.setBindings(KEYS);
    await call("openlive:flow-init");
    addon.hookError.mockReturnValue("died" as unknown as null);
    addon.registerBinding.mockClear();
    await call("openlive:flow-init");
    expect(addon.registerBinding).toHaveBeenCalledTimes(3);
  });

  it("send every effect to the router main gave", async () => {
    const { addon, call, effects } = load();
    await call("openlive:flow-init");
    const onEffect = addon.initializeHook.mock.calls[0]![0] as (e: unknown) => void;
    onEffect({ kind: "double_tap", bindingId: "flow" });
    expect(effects).toEqual([{ kind: "double_tap", bindingId: "flow" }]);
  });
});

describe("the QA keys", () => {
  afterEach(() => { delete process.env.OPENLIVE_QA_KEYS; });

  it("stand in F19, F20 and F18 for every key, and leave a key that is off off", async () => {
    process.env.OPENLIVE_QA_KEYS = "1";
    const { flowInput, addon, call } = load();
    await call("openlive:flow-init");
    flowInput.setBindings({ flow: "ctrl", dictate: "option", ptt: "fn" });
    expect(addon.registerBinding.mock.calls).toEqual([["flow", "f19", "toggle"], ["dictate", "f20", "toggle"], ["ptt", "f18", "hold"]]);
    flowInput.setBindings({ flow: "ctrl", dictate: null, ptt: null });
    expect(flowInput.binding("dictate")).toBeNull();
  });

  it("are what the tray names, registered or not: F18 is held in push to talk and would be in hands-free", async () => {
    process.env.OPENLIVE_QA_KEYS = "1";
    const { flowInput, call } = load();
    await call("openlive:flow-init");
    flowInput.setBindings({ flow: "ctrl", dictate: null, ptt: "fn" });
    expect(flowInput.binding("ptt")).toBe("f18");
    expect(flowInput.watched("ptt", "fn")).toBe("f18");
    expect(flowInput.watched("ptt", null)).toBeNull();
    delete process.env.OPENLIVE_QA_KEYS;
    expect(load().flowInput.watched("ptt", "fn")).toBe("fn");
  });

  it("open the external trigger in a packaged build", () => {
    process.env.OPENLIVE_QA_KEYS = "1";
    expect(load(undefined, { packaged: true }).handlers.has("openlive:flow-trigger")).toBe(true);
  });

  it("are off unless set to exactly 1, and a packaged build has no trigger then", async () => {
    for (const v of [undefined, "", "0", "true", "yes"]) {
      if (v === undefined) delete process.env.OPENLIVE_QA_KEYS; else process.env.OPENLIVE_QA_KEYS = v;
      const { flowInput, addon, call } = load();
      await call("openlive:flow-init");
      flowInput.setBindings({ flow: "ctrl", dictate: null, ptt: null });
      expect(addon.registerBinding.mock.calls).toEqual([["flow", "ctrl", "toggle"]]);
      expect(load(undefined, { packaged: true }).handlers.has("openlive:flow-trigger")).toBe(false);
    }
  });
});

describe("Dictate's key", () => {
  it("keeps working when Flow's own hotkey is switched off", async () => {
    const { flowInput, addon, call } = load();
    await call("openlive:flow-init");
    flowInput.setArmed(false);
    flowInput.setArmed(true);
    flowInput.teardown();
    expect(addon.suspendHook.mock.calls).toEqual([["flow"]]);
    expect(addon.resumeHook.mock.calls).toEqual([["flow"]]);
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

  it("reads the selection to edit from the page itself, never a password's, and never by copying", async () => {
    const wc = own();
    const { addon, call } = load(() => wc);
    await call("openlive:flow-accessible-selection");
    const [script] = wc.executeJavaScript.mock.calls[0] as unknown as [string];
    const selected = (activeElement: unknown, page = "") => new Function("document", "getSelection", `return ${script}`)({ activeElement }, () => page) as string;
    const box = (o: object) => ({ tagName: "INPUT", type: "text", value: "send it friday", selectionStart: 8, selectionEnd: 14, ...o });
    expect(selected(box({}))).toBe("friday");
    expect(selected({ ...box({}), tagName: "TEXTAREA" })).toBe("friday");
    expect(selected(box({ selectionStart: 3, selectionEnd: 3 }))).toBe("");
    expect(selected(box({ type: "password" }))).toBe("");
    expect(selected(box({ readOnly: true }))).toBe("");
    expect(selected({ isContentEditable: true }, "a paragraph")).toBe("a paragraph");
    expect(selected(null)).toBe("");
    expect(addon.accessibleSelection).not.toHaveBeenCalled();
  });

  it("asks the addon's accessibility read for every other app", async () => {
    const { call } = load(() => null);
    expect(await call("openlive:flow-accessible-selection")).toEqual({ ok: true, value: "the old line" });
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
