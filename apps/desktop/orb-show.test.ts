import { createRequire } from "node:module";
import { expect, it } from "vitest";

const { showOrb } = createRequire(import.meta.url)("./orb-show.cjs") as { showOrb: (win: unknown) => void };

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
