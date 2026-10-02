import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const { restoreWindow, windowSnapshot } = createRequire(import.meta.url)("./window-state.cjs");

const display = (x: number, y: number, width: number, height: number) => ({ workArea: { x, y, width, height } });
const laptop = display(0, 25, 1440, 875);          // macOS: under the menu bar
const external = display(1440, 0, 2560, 1400);     // to its right
const above = display(0, -1080, 1920, 1040);        // stacked above, Windows taskbar at the bottom
const min = { width: 940, height: 640 };
const at = (displays: unknown[], primary = laptop) => ({ displays, primary, min });

describe("restoreWindow", () => {
  it("brings back a window where it was, with its flags", () => {
    expect(restoreWindow({ x: 1600, y: 100, width: 1200, height: 800, maximized: true }, at([laptop, external])))
      .toEqual({ x: 1600, y: 100, width: 1200, height: 800, maximized: true, fullscreen: false });
    expect(restoreWindow({ x: 100, y: -900, width: 1000, height: 700, fullscreen: true }, at([laptop, above])))
      .toEqual({ x: 100, y: -900, width: 1000, height: 700, maximized: false, fullscreen: true });
  });

  it("centers on the primary display a window whose display was unplugged", () => {
    expect(restoreWindow({ x: 1600, y: 100, width: 1200, height: 800, maximized: true }, at([laptop])))
      .toEqual({ width: 1200, height: 800, maximized: true, fullscreen: false });
  });

  it("pulls a window half off its display back inside the work area", () => {
    expect(restoreWindow({ x: 1000, y: 0, width: 1200, height: 800 }, at([laptop])))
      .toEqual({ x: 240, y: 25, width: 1200, height: 800, maximized: false, fullscreen: false });
  });

  it("shrinks a window bigger than the display it is on, never under the minimum the display allows", () => {
    expect(restoreWindow({ x: 0, y: 25, width: 3000, height: 2000 }, at([laptop])))
      .toEqual({ x: 0, y: 25, width: 1440, height: 875, maximized: false, fullscreen: false });
    const tiny = display(0, 0, 800, 600);
    expect(restoreWindow({ x: 0, y: 0, width: 300, height: 200 }, at([tiny], tiny))).toMatchObject({ width: 800, height: 600 });
    expect(restoreWindow({ x: 0, y: 25, width: 300, height: 200 }, at([laptop]))).toMatchObject({ width: 940, height: 640 });
  });

  it("opens with the defaults for nothing saved or a broken file", () => {
    for (const s of [null, undefined, "x", [], {}, { width: "1200", height: 800 }, { width: NaN, height: 800 }]) expect(restoreWindow(s, at([laptop]))).toBeNull();
  });

  it("treats a window with no position as one to center", () => {
    expect(restoreWindow({ width: 1000, height: 700 }, at([laptop]))).toEqual({ width: 1000, height: 700, maximized: false, fullscreen: false });
  });
});

describe("windowSnapshot", () => {
  it("keeps the normal bounds under a maximized or fullscreen window", () => {
    const win = { getNormalBounds: () => ({ x: 10, y: 20, width: 1000, height: 700 }), isMaximized: () => false, isFullScreen: () => true };
    expect(windowSnapshot(win)).toEqual({ x: 10, y: 20, width: 1000, height: 700, maximized: false, fullscreen: true });
  });
});
