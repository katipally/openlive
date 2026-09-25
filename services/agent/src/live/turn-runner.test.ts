// A live turn streams each model step on its own and the session stores the turn as
// one text, so two steps' words must not run together: "On it.No workspace…".
import { expect, test } from "vitest";
import type { MessageBlock } from "@openlive/shared";
import { foldBlock } from "../block-emit.ts";
import { stepGap } from "./turn-runner.ts";

test("keeps a space between two steps' text in the saved turn", () => {
  const blocks: MessageBlock[] = [];
  foldBlock(blocks, { type: "text_delta", text: "On it." });
  const next = "No workspace folder is set.";
  foldBlock(blocks, { type: "text_delta", text: stepGap("On it.", next) + next });
  expect(blocks).toEqual([{ type: "text", text: "On it. No workspace folder is set." }]);
});

test("adds nothing where the boundary already has whitespace or a side is empty", () => {
  expect(stepGap("On it. ", "Next")).toBe("");
  expect(stepGap("On it.", "\nNext")).toBe("");
  expect(stepGap("", "Next")).toBe("");
  expect(stepGap("On it.", "")).toBe("");
});

test("the call's prompt gains one language line outside English, and stays byte-identical in it", async () => {
  const { withLanguage } = await import("./turn-runner.ts");
  expect(withLanguage("PROMPT")).toBe("PROMPT");
  expect(withLanguage("PROMPT", "en")).toBe("PROMPT");
  expect(withLanguage("PROMPT", "ko")).toBe("PROMPT\n\n---\nAlways reply in Korean.");
});
