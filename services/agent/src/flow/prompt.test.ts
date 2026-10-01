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
import type { Tool } from "../capabilities/types.js";

const tools = [{ name: "insert_text", promptGuidelines: ["Type only the words."] }] as unknown as Tool[];

test("English adds nothing; another language adds one line at the end", () => {
  const en = buildFlowPrompt({ tools });
  expect(buildFlowPrompt({ tools, lang: "en" })).toBe(en);
  expect(en).not.toContain("Always reply in");
  expect(buildFlowPrompt({ tools, lang: "de" })).toBe(`${en}\n\nAlways reply in German.`);
  expect(buildFlowPrompt({ tools: [], lang: "hi" })).toBe(`${buildFlowPrompt({ tools: [] })}\n\nAlways reply in Hindi.`);
});

test("both brains, in Flow and in calls, are told never to claim an action they did not take", () => {
  for (const said of [buildFlowPrompt({ tools }), buildFlowAcpPreamble({ tools }), buildLivePrompt([]), preamble()]) expect(said).toContain("Never say something is done unless a tool of yours did it");
});

test("the coding agent's preamble has no language line", () => {
  expect(buildFlowAcpPreamble({ tools })).not.toContain("Always reply in");
});

test("both Flow brains follow the user's custom instructions, as calls do", () => {
  settings.set("customInstructions", "  Call me Captain.  ");
  try {
    for (const said of [buildFlowPrompt({ tools }), buildFlowAcpPreamble({ tools }), buildLivePrompt([]), preamble()]) expect(said).toContain("Call me Captain.");
    expect(buildFlowPrompt({ tools, lang: "de" })).toMatch(/Call me Captain\.\n\nAlways reply in German\.$/);
  } finally { settings.delete("customInstructions"); }
  expect(buildFlowPrompt({ tools })).not.toContain("How the user wants you");
});

test("both modes' prompts carry the lines of the tools the session has, and only those", async () => {
  const { registry } = await import("../capabilities/registry.js");
  const { CHAT, FLOW } = await import("../capabilities/profiles.js");
  const clipboard = { read: async () => "", write: async () => {} };
  const call = registry.tools(CHAT, { clipboard, openUrl: async () => "", share: { showing: () => null, frame: async () => null }, workspace: () => "" }).list;
  const chatPrompt = CHAT.prompt(call);
  expect(chatPrompt).toContain("- You have an assistant who owns the web tools");
  expect(chatPrompt).toContain("- Read before you edit so your snippet matches exactly.");
  expect(chatPrompt).toContain("Call `look`");
  expect(chatPrompt).not.toContain("insert_text them");
  expect(CHAT.prompt(call, "de")).toBe(`${chatPrompt}\n\n---\nAlways reply in German.`);

  const flow = registry.tools(FLOW, { foreground: { capture: async () => null }, insert: { commit: async () => {}, end: async () => {}, abandon: async () => {}, committed: () => "" }, clipboard }).list;
  const flowPrompt = FLOW.prompt(flow);
  expect(flowPrompt).toContain("- When they want words in their app, insert_text them");
  expect(flowPrompt).toContain("- You have an assistant who owns the web tools");
  expect(flowPrompt).not.toContain("Call `look`");
  expect(flowPrompt).not.toContain("Read before you edit");
});
