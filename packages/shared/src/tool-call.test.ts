// The merge is the contract between ACP's sparse tool_call_update stream and
// everything downstream (wire, DB, UI). Absent-field semantics breaking would
// silently wipe diffs or statuses mid-turn.
import { expect, test } from "vitest";
import { capToolContent, mergeToolCall, visibleContent, type ToolCallState } from "./tool-call";

const call: ToolCallState = {
  id: "t1", title: "Edit parser", kind: "edit", status: "in_progress",
  content: [{ type: "diff", path: "/repo/a.ts", oldText: "old", newText: "new" }],
  locations: [{ path: "/repo/a.ts", line: 3 }],
  rawInputJson: '{"path":"/repo/a.ts"}',
};

test("absent fields leave the call unchanged; present fields overwrite", () => {
  const merged = mergeToolCall(call, { id: "t1", status: "completed" });
  expect(merged.status).toBe("completed");
  expect(merged.title).toBe("Edit parser");
  expect(merged.content).toEqual(call.content);
  expect(merged.rawInputJson).toBe(call.rawInputJson);
  expect(merged).not.toBe(call); // new object — React identity
});

test("content and locations are full replacements (including shrink-to-empty)", () => {
  const merged = mergeToolCall(call, { id: "t1", content: [], locations: [] });
  expect(merged.content).toEqual([]);
  expect(merged.locations).toEqual([]);
});

test("update for an unknown id synthesizes a failed placeholder, then applies the delta", () => {
  const ghost = mergeToolCall(undefined, { id: "ghost", title: "Late update" });
  expect(ghost.status).toBe("failed");
  expect(ghost.title).toBe("Late update");
  const ghostWithStatus = mergeToolCall(undefined, { id: "g2", status: "completed" });
  expect(ghostWithStatus.status).toBe("completed"); // delta's own status wins
});

test("rawOutput is visible content only while real content is empty", () => {
  const bare: ToolCallState = { ...call, content: [], rawOutputJson: '{"ok":true}' };
  expect(visibleContent(bare)).toEqual([{ type: "text", text: '{"ok":true}' }]);
  expect(visibleContent(call)).toEqual(call.content); // real content wins
  expect(visibleContent({ ...call, content: [] })).toEqual([]);
});

test("caps clip oversized diffs and mark them", () => {
  const big = capToolContent({ type: "diff", path: "/a", oldText: "x".repeat(200_000), newText: "y".repeat(200_000) });
  if (big.type !== "diff") throw new Error("kind changed");
  expect(big.clipped).toBe(true);
  expect((big.oldText?.length ?? 0) + big.newText.length).toBeLessThanOrEqual(256 * 1024);
  const small = capToolContent({ type: "diff", path: "/a", newText: "tiny" });
  expect(small).toEqual({ type: "diff", path: "/a", newText: "tiny" });
});
