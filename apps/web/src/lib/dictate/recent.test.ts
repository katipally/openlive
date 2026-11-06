import { beforeEach, describe, expect, it } from "vitest";
import { forgetDictations, recentFor, rememberDictation } from "./recent";

beforeEach(forgetDictations);

describe("recent dictations", () => {
  it("is empty for an unknown window and for no window id", () => {
    expect(recentFor(1)).toEqual([]);
    rememberDictation(undefined, "hello");
    expect(recentFor(undefined)).toEqual([]);
  });

  it("returns one window's dictations alone, oldest first", () => {
    rememberDictation(1, "first");
    rememberDictation(2, "other window");
    rememberDictation(1, "second");
    expect(recentFor(1)).toEqual(["first", "second"]);
    expect(recentFor(2)).toEqual(["other window"]);
  });

  it("keeps the newest five and ignores blanks", () => {
    for (const t of ["a", "b", "c", "d", "e", "f", "  "]) rememberDictation(1, t);
    expect(recentFor(1)).toEqual(["b", "c", "d", "e", "f"]);
  });

  it("stays within 1200 characters, newest first to fit", () => {
    rememberDictation(1, "x".repeat(900));
    rememberDictation(1, "y".repeat(900));
    const out = recentFor(1);
    expect(out.join("").length).toBe(1200);
    expect(out[1]).toBe("y".repeat(900));
  });

  it("drops what is half an hour old", () => {
    rememberDictation(1, "old", 0);
    rememberDictation(1, "new", 29 * 60_000);
    expect(recentFor(1, 31 * 60_000)).toEqual(["new"]);
  });

  it("holds at most 20 windows, forgetting the least recently typed in", () => {
    for (let i = 1; i <= 21; i++) rememberDictation(i, "t");
    expect(recentFor(1)).toEqual([]);
    expect(recentFor(21)).toEqual(["t"]);
  });
});
