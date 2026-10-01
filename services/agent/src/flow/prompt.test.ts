// Flow's prompt in the session language: one line added outside English,
// nothing changed in it, and never in the coding agent's session preamble
// (its turns carry the language instead, see brain.test.ts).
import { expect, test, vi } from "vitest";

const settings = new Map<string, string>();
vi.mock("@openlive/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openlive/db")>()),
  getSetting: (k: string) => settings.get(k),
}));
import { preamble } from "../agents/acp-agent.js";
import { buildLivePrompt } from "../prompt.js";
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

test("both brains, in Flow and in calls, are told never to claim an action they did not take", () => {
  for (const said of [buildFlowPrompt({ tools }), buildFlowAcpPreamble({ tools }), buildLivePrompt(), preamble()]) expect(said).toContain("Never say something is done unless a tool of yours did it");
});

test("the coding agent's preamble has no language line", () => {
  expect(buildFlowAcpPreamble({ tools })).not.toContain("Always reply in");
});

test("both Flow brains follow the user's custom instructions, as calls do", () => {
  settings.set("customInstructions", "  Call me Captain.  ");
  try {
    for (const said of [buildFlowPrompt({ tools }), buildFlowAcpPreamble({ tools }), buildLivePrompt(), preamble()]) expect(said).toContain("Call me Captain.");
    expect(buildFlowPrompt({ tools, lang: "de" })).toMatch(/Call me Captain\.\n\nAlways reply in German\.$/);
  } finally { settings.delete("customInstructions"); }
  expect(buildFlowPrompt({ tools })).not.toContain("How the user wants you");
});
