import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const { restoreWindow, minFor, fitRect, firstRunWindow, windowSnapshot } = createRequire(import.meta.url)("./window-state.cjs");

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

describe("minFor", () => {
  it("is the minimum where the work area holds it, and the work area where it does not", () => {
    expect(minFor(min, laptop.workArea)).toEqual(min);
    expect(minFor(min, { x: 0, y: 0, width: 640, height: 480 })).toEqual({ width: 640, height: 480 });
    expect(minFor(min, { x: 0, y: 0, width: 1920, height: 400 })).toEqual({ width: 940, height: 400 });
  });
});

describe("fitRect", () => {
  it("leaves a window that fits where it is", () => {
    expect(fitRect({ x: 100, y: 100, width: 1000, height: 700 }, laptop.workArea, min)).toEqual({ x: 100, y: 100, width: 1000, height: 700 });
  });
  it("shrinks a window the work area cannot hold and pulls it inside", () => {
    expect(fitRect({ x: 300, y: 300, width: 1180, height: 800 }, { x: 0, y: 0, width: 1024, height: 576 }, min))
      .toEqual({ x: 0, y: 0, width: 1024, height: 576 });
    expect(fitRect({ x: -200, y: 900, width: 1000, height: 700 }, laptop.workArea, min)).toEqual({ x: 0, y: 200, width: 1000, height: 700 });
  });
  it("never goes under the minimum the work area allows", () => {
    expect(fitRect({ x: 0, y: 0, width: 100, height: 100 }, laptop.workArea, min)).toMatchObject({ width: 940, height: 640 });
  });
});

describe("firstRunWindow", () => {
  const preferred = { width: 1180, height: 800 };
  it("opens the preferred size centered in a work area that holds it", () => {
    expect(firstRunWindow(preferred, laptop.workArea, min)).toEqual({ x: 130, y: 63, width: 1180, height: 800 });
    expect(firstRunWindow(preferred, external.workArea, min)).toEqual({ x: 2130, y: 300, width: 1180, height: 800 });
  });
  it("shrinks to a work area that cannot hold it, such as 1080p at 150 percent", () => {
    expect(firstRunWindow(preferred, { x: 0, y: 0, width: 1280, height: 672 }, min)).toEqual({ x: 50, y: 0, width: 1180, height: 672 });
    expect(firstRunWindow(preferred, { x: 0, y: 0, width: 1000, height: 600 }, min)).toEqual({ x: 0, y: 0, width: 1000, height: 600 });
  });
  it("fills a work area smaller than the minimum, never spilling off it", () => {
    expect(firstRunWindow(preferred, { x: 10, y: 20, width: 800, height: 500 }, min)).toEqual({ x: 10, y: 20, width: 800, height: 500 });
  });
});

describe("windowSnapshot", () => {
  it("keeps the normal bounds under a maximized or fullscreen window", () => {
    const win = { getNormalBounds: () => ({ x: 10, y: 20, width: 1000, height: 700 }), isMaximized: () => false, isFullScreen: () => true };
    expect(windowSnapshot(win)).toEqual({ x: 10, y: 20, width: 1000, height: 700, maximized: false, fullscreen: true });
  });
});
