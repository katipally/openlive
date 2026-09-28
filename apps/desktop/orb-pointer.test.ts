import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const { pointerMode, pointInWindow, samePoint } = createRequire(import.meta.url)("./orb-pointer.cjs");

describe("pointerMode", () => {
  it("lets macOS and Windows forward moves", () => {
    expect(pointerMode("darwin", {})).toBe("forward");
    expect(pointerMode("win32", { XDG_SESSION_TYPE: "wayland" })).toBe("forward");
  });
  it("polls on X11", () => {
    expect(pointerMode("linux", { XDG_SESSION_TYPE: "x11" })).toBe("poll");
    expect(pointerMode("linux", {})).toBe("poll");
  });
  it("stays clickable on Wayland, however it is named", () => {
    expect(pointerMode("linux", { XDG_SESSION_TYPE: "wayland" })).toBe("solid");
    expect(pointerMode("linux", { XDG_SESSION_TYPE: "Wayland" })).toBe("solid");
    expect(pointerMode("linux", { WAYLAND_DISPLAY: "wayland-0" })).toBe("solid");
  });
});

describe("pointInWindow", () => {
  const win = { x: 500, y: 700, width: 416, height: 460 };
  it("turns a screen point into a window point", () => {
    expect(pointInWindow({ x: 500, y: 700 }, win)).toEqual({ x: 0, y: 0 });
    expect(pointInWindow({ x: 708, y: 1000 }, win)).toEqual({ x: 208, y: 300 });
  });
  it("is null anywhere outside, edges included", () => {
    expect(pointInWindow({ x: 499, y: 800 }, win)).toBeNull();
    expect(pointInWindow({ x: 916, y: 800 }, win)).toBeNull();
    expect(pointInWindow({ x: 600, y: 1160 }, win)).toBeNull();
    expect(pointInWindow({ x: 600, y: 10 }, win)).toBeNull();
  });
  it("works on a display left of or above the primary", () => {
    expect(pointInWindow({ x: -1800, y: -300 }, { x: -1900, y: -400, width: 416, height: 460 })).toEqual({ x: 100, y: 100 });
  });
});

describe("samePoint", () => {
  it("compares by value and treats two nulls as the same", () => {
    expect(samePoint(null, null)).toBe(true);
    expect(samePoint({ x: 1, y: 2 }, { x: 1, y: 2 })).toBe(true);
    expect(samePoint({ x: 1, y: 2 }, null)).toBe(false);
    expect(samePoint({ x: 1, y: 2 }, { x: 2, y: 2 })).toBe(false);
  });
});
