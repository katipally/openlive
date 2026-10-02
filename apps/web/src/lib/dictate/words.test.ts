import { describe, expect, it } from "vitest";
import { applyDictionary, snippetFor, spokenCommand, type SpokenCommand } from "./words";

const WORDS = ["OpenLive", "Maya", "Will", "useGSAP", "GSAP", "Claude Code", "Smart-Turn", "kubectl", "ACP"];

describe("the dictionary", () => {
  it("writes split, joined and miscased words the way the entry spells them", () => {
    expect(applyDictionary("I use open live every day.", WORDS)).toBe("I use OpenLive every day.");
    expect(applyDictionary("Openlive is up.", WORDS)).toBe("OpenLive is up.");
    expect(applyDictionary("ask maya, then claude code.", WORDS)).toBe("ask Maya, then Claude Code.");
    expect(applyDictionary("Try smart turn and use gsap.", WORDS)).toBe("Try Smart-Turn and useGSAP.");
    expect(applyDictionary("Kubectl rolled it out over a c p.", WORDS)).toBe("kubectl rolled it out over ACP.");
  });

  it("keeps a possessive and the punctuation around a match", () => {
    expect(applyDictionary("(open live's settings)", WORDS)).toBe("(OpenLive's settings)");
  });

  it("leaves common words alone, and never joins across a pause or a line", () => {
    expect(applyDictionary("I will go now.", WORDS)).toBe("I will go now.");
    expect(applyDictionary("Open, live it up.", WORDS)).toBe("Open, live it up.");
    expect(applyDictionary("1. Open\n2. live", WORDS)).toBe("1. Open\n2. live");
    expect(applyDictionary("The openlives are fine.", WORDS)).toBe("The openlives are fine.");
  });

  it("returns the text untouched with no words", () => {
    expect(applyDictionary("open live", [])).toBe("open live");
  });

  it("stays linear on a long dictation and a long list", () => {
    const many = Array.from({ length: 2000 }, (_, i) => `Term${i}x`);
    const said = Array.from({ length: 20_000 }, (_, i) => (i % 100 ? "word" : "term5x")).join(" ");
    const t = performance.now();
    const out = applyDictionary(said, many);
    expect(performance.now() - t).toBeLessThan(1000);
    expect(out.startsWith("Term5x word")).toBe(true);
  });
});

describe("snippets", () => {
  const SNIPPETS = [{ trigger: "my address", text: "221B Baker Street" }, { trigger: "Sign off", text: "Thanks,\nYash" }];

  it("expands a trigger said alone, whatever its case and punctuation", () => {
    expect(snippetFor("My address.", SNIPPETS)).toBe("221B Baker Street");
    expect(snippetFor("sign off!", SNIPPETS)).toBe("Thanks,\nYash");
  });

  it("does not expand a trigger inside a sentence", () => {
    expect(snippetFor("Send it to my address.", SNIPPETS)).toBeNull();
    expect(snippetFor("anything", [])).toBeNull();
  });
});

describe("spoken commands", () => {
  const ALL = new Set<SpokenCommand>(["enter", "newLine", "newParagraph", "undo", "stop"]);

  it("hears a command said alone", () => {
    expect(spokenCommand("Press enter.", ALL)).toEqual({ command: "enter", before: "" });
    expect(spokenCommand("new paragraph", ALL)).toEqual({ command: "newParagraph", before: "" });
    expect(spokenCommand("Undo that.", ALL)).toEqual({ command: "undo", before: "" });
  });

  it("hears one at the tail after a sentence end or a pause", () => {
    expect(spokenCommand("Sounds good. Press enter.", ALL)).toEqual({ command: "enter", before: "Sounds good." });
    expect(spokenCommand("First point, new line", ALL)).toEqual({ command: "newLine", before: "First point," });
    expect(spokenCommand("Hello there New line.", ALL)).toEqual({ command: "newLine", before: "Hello there" });
  });

  it("leaves the words alone when they are part of the sentence", () => {
    expect(spokenCommand("I will press enter later", ALL)).toBeNull();
    expect(spokenCommand("Tell him to press enter.", ALL)).toBeNull();
    expect(spokenCommand("Start a new line of products", ALL)).toBeNull();
    expect(spokenCommand("That was bad. Undo that.", ALL)).toBeNull();
    expect(spokenCommand("We watched Visit New Line", ALL)).toBeNull();
  });

  it("ignores a command that is switched off", () => {
    expect(spokenCommand("press enter", new Set(["newLine"]))).toBeNull();
  });
});
