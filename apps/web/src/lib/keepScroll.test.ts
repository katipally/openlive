import { describe, expect, it } from "vitest";
import { canRelease } from "./keepScroll";

describe("canRelease", () => {
  it("keeps the floor while dropping it would clamp the scroll position", () => {
    // 1000 tall with 400 of floor, a 500 view scrolled to the bottom (500).
    expect(canRelease(500, 1000, 500, 400)).toBe(false);
  });
  it("lets it go once the reader is above the floor", () => {
    expect(canRelease(100, 1000, 500, 400)).toBe(true);
    expect(canRelease(0, 600, 500, 400)).toBe(true);
  });
});
