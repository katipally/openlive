// A spoken answer to a permission/elicitation modal must be understood as the answer
// — never leak to the agent. These interpreters are the core of that routing.
import { expect, test } from "vitest";
import { classifyYesNo, buildElicitationAnswer } from "./modalAnswer.ts";

test("permission: clear yes / no, ambiguous stays null", () => {
  expect(classifyYesNo("yes go ahead")).toBe("allow");
  expect(classifyYesNo("sure, do it")).toBe("allow");
  expect(classifyYesNo("no, don't")).toBe("deny");
  expect(classifyYesNo("cancel that")).toBe("deny");
  expect(classifyYesNo("hmm what do you think")).toBeNull(); // → keep waiting, NOT sent to agent
});

const topicSchema = { properties: { topic: { enum: ["Personal portfolio", "Landing page for an idea", "Blog", "Something else"] }, other: { type: "string" } } };

test("elicitation form: spoken choice matches a listed option", () => {
  expect(buildElicitationAnswer(topicSchema, "Blog")).toEqual({ topic: "Blog" });
  expect(buildElicitationAnswer(topicSchema, "let's do a personal portfolio")).toEqual({ topic: "Personal portfolio" });
});

test("elicitation form: unmatched answer drops into the free-text field (never null when a free field exists)", () => {
  expect(buildElicitationAnswer(topicSchema, "a cooking recipes site")).toEqual({ other: "a cooking recipes site" });
});

test("elicitation form: oneOf options + array field", () => {
  // Realistic word-length option values (the substring match over-matches on tiny
  // values like a bare "l", so real schemas use words — as agents do).
  const s = { properties: { size: { oneOf: [{ const: "small", title: "Small" }, { const: "large", title: "Large" }] }, tags: { type: "array", items: { enum: ["red", "blue"] } } } };
  expect(buildElicitationAnswer(s, "Large")).toEqual({ size: "large" });
  expect(buildElicitationAnswer(s, "blue")).toEqual({ tags: ["blue"] });
});

test("elicitation: nothing to fill (no props / empty text) → null", () => {
  expect(buildElicitationAnswer({}, "Blog")).toBeNull();
  expect(buildElicitationAnswer(topicSchema, "")).toBeNull();
});
