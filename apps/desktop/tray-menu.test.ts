import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const { trayTemplate, statusLine, hotkeyLabel, STATUS } = createRequire(import.meta.url)("./tray-menu.cjs");

const act = { open: vi.fn(), startFlow: vi.fn(), allowAccess: vi.fn(), settings: vi.fn(), quit: vi.fn() };
const ready = { readiness: "ready", open: false, binding: "ctrl", platform: "darwin" };
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
  it("is the minimal menu: status, open, start, settings, quit", () => {
    expect(labels(ready)).toEqual(["Flow is ready  ·  Double-tap ⌃", "separator", "Open OpenLive", "Start Flow", "Settings…", "separator", "Quit OpenLive"]);
  });

  it("keeps the status line read-only and shows Settings' own shortcut", () => {
    const items = trayTemplate(ready, act);
    expect(items[0].enabled).toBe(false);
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

  it("runs the action each item names", () => {
    const items = trayTemplate(ready, act);
    for (const [label, fn] of [["Open OpenLive", act.open], ["Start Flow", act.startFlow], ["Settings…", act.settings], ["Quit OpenLive", act.quit]] as const) {
      expect(items.find((i: { label?: string }) => i.label === label).click).toBe(fn);
    }
  });
});
