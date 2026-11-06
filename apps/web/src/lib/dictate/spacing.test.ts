import { describe, expect, it } from "vitest";
import { needsSpace } from "./spacing";

describe("needsSpace", () => {
  it("adds one after a word or closing punctuation", () => {
    expect(needsSpace("word")).toBe(true);
    expect(needsSpace("Hello.")).toBe(true);
    expect(needsSpace("(done)")).toBe(true);
  });
  it("never doubles a space", () => {
    expect(needsSpace("word ")).toBe(false);
    expect(needsSpace("word\t")).toBe(false);
  });
  it("adds none after an opening bracket or quote", () => {
    for (const c of ["(", "[", "{", "\"", "'", "“", "‘", "«"]) expect(needsSpace(`say ${c}`)).toBe(false);
  });
  it("adds none at the start of a field or after a newline", () => {
    expect(needsSpace("")).toBe(false);
    expect(needsSpace("first line\n")).toBe(false);
    expect(needsSpace("first line\r\n")).toBe(false);
  });
});
