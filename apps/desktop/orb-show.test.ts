import { createRequire } from "node:module";
import { expect, it } from "vitest";

const { showOrb, dockStepsAside } = createRequire(import.meta.url)("./orb-show.cjs") as {
  showOrb: (win: unknown) => void;
  dockStepsAside: (o: { platform: string; dockVisible: boolean; hasTray: boolean; mainFocused: boolean }) => boolean;
};

/** An orb window that records what was done to it, in order. */
function fakeWin(visible: boolean) {
  const did: string[] = [];
  return {
    did,
    setAlwaysOnTop: () => did.push("level"),
    setVisibleOnAllWorkspaces: (_on: boolean, o: { visibleOnFullScreen: boolean }) => did.push(o.visibleOnFullScreen ? "spaces+fullscreen" : "spaces"),
    // A window already up emits no "show" for this, as Electron's does not.
    showInactive: () => { if (!visible) did.push("show-event"); visible = true; },
    webContents: { send: (ch: string) => did.push(ch) },
  };
}

it("tells the orb it is shown once it is on screen, whether or not the window emitted a show", () => {
  for (const visible of [false, true]) {
    const win = fakeWin(visible);
    showOrb(win);
    expect(win.did.at(-1)).toBe("openlive:flow-shown");
    expect(win.did.indexOf("openlive:flow-shown")).toBeGreaterThan(win.did.indexOf("level"));
    expect(win.did).toContain("spaces+fullscreen");
  }
});

it("moves the Dock icon aside only on macOS, with a tray to come back from, while OpenLive is not in front", () => {
  const base = { platform: "darwin", dockVisible: true, hasTray: true, mainFocused: false };
  expect(dockStepsAside(base)).toBe(true);
  expect(dockStepsAside({ ...base, dockVisible: false })).toBe(false);
  expect(dockStepsAside({ ...base, hasTray: false })).toBe(false);
  expect(dockStepsAside({ ...base, mainFocused: true })).toBe(false);
  for (const platform of ["win32", "linux"]) expect(dockStepsAside({ ...base, platform })).toBe(false);
});
