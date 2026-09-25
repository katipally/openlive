// Flow's prompt in the session language: one line added outside English,
// nothing changed in it, and never in the coding agent's session preamble
// (its turns carry the language instead, see brain.test.ts).
import { expect, test } from "vitest";
import { buildFlowAcpPreamble, buildFlowPrompt } from "./prompt.js";
import type { Tool } from "./types.js";

const tools = [{ name: "insert_text", promptGuidelines: ["Type only the words."] }] as unknown as Tool[];

test("English adds nothing; another language adds one line at the end", () => {
  const en = buildFlowPrompt({ tools });
  expect(buildFlowPrompt({ tools, lang: "en" })).toBe(en);
  expect(en).not.toContain("Always reply in");
  expect(buildFlowPrompt({ tools, lang: "de" })).toBe(`${en}\n\nAlways reply in German.`);
  expect(buildFlowPrompt({ tools: [], lang: "hi" })).toBe(`${buildFlowPrompt({ tools: [] })}\n\nAlways reply in Hindi.`);
});

test("the coding agent's preamble has no language line", () => {
  expect(buildFlowAcpPreamble({ tools })).not.toContain("Always reply in");
});
