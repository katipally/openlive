import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const { trayTemplate, statusLine, dictateLine, hotkeyLabel, talkItems, STATUS, DICTATE } = createRequire(import.meta.url)("./tray-menu.cjs");

const act = { open: vi.fn(), startFlow: vi.fn(), flowOn: vi.fn(), flowOff: vi.fn(), dictateOn: vi.fn(), dictateOff: vi.fn(), talkHandsFree: vi.fn(), talkPtt: vi.fn(), allowAccess: vi.fn(), settings: vi.fn(), quit: vi.fn() };
const ready = { readiness: "ready", open: false, binding: "ctrl", platform: "darwin", hook: "ready", armed: true, dictate: { on: false, binding: "option_right" } };
const labels = (state: object) => trayTemplate(state, act).map((i: { label?: string; type?: string }) => i.label ?? i.type);

describe("the tray's status line", () => {
  it("says every state in plain words", () => {
    expect(statusLine({ ...ready })).toBe("Flow is ready  ·  Double-tap ⌃");
    expect(statusLine({ ...ready, open: true })).toBe("Flow is open  ·  Double-tap ⌃");
    expect(statusLine({ ...ready, readiness: "access" })).toBe("Flow needs permission");
    expect(statusLine({ ...ready, readiness: "stopped" })).toBe("Flow stopped listening");
    expect(statusLine({ ...ready, readiness: "off" })).toBe("Flow is off");
    expect(statusLine({ ...ready, readiness: "off", open: true })).toBe("Flow is off");
    expect(statusLine({ ...ready, readiness: "something new" })).toBe("Flow is off");
    for (const words of Object.values(STATUS)) expect(words).not.toMatch(/:|\(/);
  });

  it("shows the hotkey only once one is registered", () => {
    expect(statusLine({ ...ready, binding: null })).toBe("Flow is ready");
  });
});

describe("the tray's Dictate line", () => {
  it("says whether Dictate is on, and its gesture while it would work", () => {
    expect(dictateLine(ready)).toBe("Dictate is off");
    const on = { ...ready, dictate: { on: true, binding: "option" } };
    expect(dictateLine(on)).toBe("Dictate is on  ·  Double-tap ⌥");
    expect(dictateLine({ ...on, platform: "win32" })).toBe("Dictate is on  ·  Double-tap Alt");
    expect(dictateLine({ ...on, dictate: { on: true, binding: "option_left" }, platform: "linux" })).toBe("Dictate is on  ·  Double-tap Left Alt");
    expect(dictateLine({ ...on, dictate: { on: true, binding: null } })).toBe("Dictate is on");
    expect(dictateLine({ ...on, hook: "access" })).toBe("Dictate needs permission");
    expect(dictateLine({ ...on, hook: "stopped" })).toBe("Dictate stopped listening");
    expect(dictateLine({ ...on, hook: "off" })).toBe("Dictate stopped listening");
    expect(dictateLine({ ...ready, dictate: null })).toBe("Dictate is off");
    for (const words of Object.values(DICTATE)) expect(words).not.toMatch(/:|\(/);
  });

  it("follows Dictate's own switch, not Flow's", () => {
    expect(dictateLine({ ...ready, readiness: "off", dictate: { on: true, binding: "f20" } })).toBe("Dictate is on  ·  Double-tap F20");
  });
});

describe("hotkeyLabel", () => {
  it("writes the registered key the way each platform does", () => {
    expect(hotkeyLabel("ctrl", "darwin")).toBe("Double-tap ⌃");
    expect(hotkeyLabel("ctrl", "win32")).toBe("Double-tap Ctrl");
    expect(hotkeyLabel("ctrl", "linux")).toBe("Double-tap Ctrl");
    expect(hotkeyLabel("option+shift", "darwin")).toBe("Double-tap ⌥⇧");
    expect(hotkeyLabel("option+shift", "win32")).toBe("Double-tap Alt+Shift");
    expect(hotkeyLabel("command", "win32")).toBe("Double-tap Win");
    expect(hotkeyLabel("command", "linux")).toBe("Double-tap Super");
    expect(hotkeyLabel("ctrl_right", "linux")).toBe("Double-tap Right Ctrl");
    expect(hotkeyLabel("f13", "freebsd")).toBe("Double-tap F13");
    expect(hotkeyLabel(null, "darwin")).toBe("");
  });
});

describe("trayTemplate", () => {
  it("is the minimal menu: both statuses, open, start, both switches, settings, quit", () => {
    expect(labels(ready)).toEqual(["Flow is ready  ·  Double-tap ⌃", "Dictate is off", "separator", "Open OpenLive", "Start Flow", "Turn Flow off", "Turn Dictate on", "How you talk", "Settings…", "separator", "Quit OpenLive"]);
  });

  it("turns Flow on or off, and says so on its status line", () => {
    const item = (state: object) => trayTemplate(state, act).find((i: { label?: string }) => /^Turn Flow/.test(i.label ?? ""));
    expect(item(ready)).toMatchObject({ label: "Turn Flow off", click: act.flowOff });
    const off = { ...ready, readiness: "off", armed: false };
    expect(item(off)).toMatchObject({ label: "Turn Flow on", click: act.flowOn });
    expect(item(off).enabled).not.toBe(false);
    expect(labels(off).slice(0, 2)).toEqual(["Flow is off", "Dictate is off"]);
  });

  it("turns Dictate on or off, once its settings have been read", () => {
    const item = (state: object) => trayTemplate(state, act).find((i: { label?: string }) => /^Turn Dictate/.test(i.label ?? ""));
    expect(item(ready)).toMatchObject({ label: "Turn Dictate on", enabled: true, click: act.dictateOn });
    expect(item({ ...ready, dictate: { on: true, binding: "option_right" } })).toMatchObject({ label: "Turn Dictate off", enabled: true, click: act.dictateOff });
    expect(item({ ...ready, dictate: null }).enabled).toBe(false);
  });

  it("offers the grant for Dictate too, while Flow is off", () => {
    const dictating = { ...ready, readiness: "off", hook: "access", dictate: { on: true, binding: "option_right" } };
    expect(labels(dictating)).toContain("Allow Accessibility…");
    expect(labels({ ...dictating, dictate: { on: false, binding: "option_right" } })).not.toContain("Allow Accessibility…");
  });

  it("keeps the status line read-only and shows Settings' own shortcut", () => {
    const items = trayTemplate(ready, act);
    expect(items[0].enabled).toBe(false);
    expect(items[1].enabled).toBe(false);
    expect(items.find((i: { label?: string }) => i.label === "Settings…").accelerator).toBe("CmdOrCtrl+,");
    // ⌘Q only closes to the menu bar, so Quit shows no shortcut.
    expect(items.find((i: { label?: string }) => i.label === "Quit OpenLive").accelerator).toBeUndefined();
  });

  it("enables Start Flow only when a double tap would work", () => {
    const start = (state: object) => trayTemplate(state, act).find((i: { label?: string }) => i.label === "Start Flow");
    expect(start(ready).enabled).toBe(true);
    for (const readiness of ["access", "stopped", "off"]) expect(start({ ...ready, readiness }).enabled).toBe(false);
  });

  it("offers the fix in place when a grant is all that is missing, in the platform's words", () => {
    expect(labels({ ...ready, readiness: "access" })).toContain("Allow Accessibility…");
    expect(labels({ ...ready, readiness: "access", platform: "linux" })).toContain("Allow input access…");
    expect(labels({ ...ready, readiness: "off" })).not.toContain("Allow Accessibility…");
  });

  it("picks how you talk from two radio items, once Flow's settings are read", () => {
    const menu = (state: object) => trayTemplate(state, act).find((i: { label?: string }) => i.label === "How you talk");
    expect(menu(ready).enabled).toBe(false);
    const ptt = { ...ready, talk: { mode: "ptt", pttKey: "fn" } };
    expect(menu(ptt).enabled).toBe(true);
    expect(menu(ptt).submenu).toMatchObject([
      { label: "Hands-free", type: "radio", checked: false, click: act.talkHandsFree },
      { label: "Push to talk  ·  Hold Fn", type: "radio", checked: true, click: act.talkPtt },
    ]);
    expect(talkItems({ talk: { mode: "handsFree", pttKey: "ctrl_right" }, platform: "win32" }, act).map((i: { label: string; checked: boolean }) => [i.label, i.checked]))
      .toEqual([["Hands-free", true], ["Push to talk  ·  Hold Right Ctrl", false]]);
  });

  it("runs the action each item names", () => {
    const items = trayTemplate(ready, act);
    for (const [label, fn] of [["Open OpenLive", act.open], ["Start Flow", act.startFlow], ["Settings…", act.settings], ["Quit OpenLive", act.quit]] as const) {
      expect(items.find((i: { label?: string }) => i.label === label).click).toBe(fn);
    }
  });
});
