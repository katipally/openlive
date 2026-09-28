import { describe, expect, it } from "vitest";
import { isTruncated } from "./truncated";

const box = (scrollWidth: number, clientWidth: number, scrollHeight = 20, clientHeight = 20) => ({ scrollWidth, clientWidth, scrollHeight, clientHeight });

describe("isTruncated", () => {
  it("is false when the text fits", () => {
    expect(isTruncated(box(120, 120))).toBe(false);
    expect(isTruncated(box(80, 120))).toBe(false);
  });
  it("catches an ellipsis", () => {
    expect(isTruncated(box(300, 120))).toBe(true);
  });
  it("catches a line clamp", () => {
    expect(isTruncated(box(120, 120, 60, 40))).toBe(true);
  });
  it("treats an empty box as not truncated", () => {
    expect(isTruncated(box(0, 0, 0, 0))).toBe(false);
  });
});
