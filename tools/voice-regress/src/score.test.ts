import { describe, expect, it } from "vitest";
import { tagProb, wer, words } from "./score";

describe("wer", () => {
  it("is 0 for the same words whatever the case, punctuation or digits", () => {
    expect(wer("The high is seventy two, isn't it?", "the high is 72 isn't it")).toBe(0);
  });

  it("counts a substitution, an insertion and a deletion over the reference length", () => {
    expect(wer("one two three four", "one too three four")).toBe(0.25);
    expect(wer("one two", "one two three")).toBe(0.5);
    expect(wer("one two three four", "one three four")).toBe(0.25);
  });

  it("handles empty sides", () => {
    expect(wer("", "")).toBe(0);
    expect(wer("", "hi")).toBe(1);
    expect(wer("hi there", "")).toBe(1);
  });

  it("keeps apostrophes inside words only", () => {
    expect(words("'Rock' 'n' roll, don't")).toEqual(["rock", "n", "roll", "don't"]);
  });
});

describe("tagProb", () => {
  it("takes the best of the tag's classes and ignores the rest", () => {
    const events = [{ name: "Speech", prob: 0.9 }, { name: "Giggle", prob: 0.2 }, { name: "Laughter", prob: 0.6 }];
    expect(tagProb("laugh", events)).toBe(0.6);
    expect(tagProb("cough", events)).toBe(0);
    expect(tagProb("unknown", events)).toBe(0);
  });
});
