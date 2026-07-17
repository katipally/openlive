// foldBlock turns the live event stream back into an ordered transcript; if the
// acp_tool merge or the terminal snapshot breaks, saved conversations lose the
// coding agent's work (or keep "in_progress" ghosts forever).
import { expect, test } from "vitest";
import type { MessageBlock, ToolCallState } from "@openlive/shared";
import { finalizeToolBlocks, foldBlock, newFoldCtx } from "./block-emit.ts";

const call: ToolCallState = {
  id: "t1", title: "Run tests", kind: "execute", status: "pending",
  content: [{ type: "terminal", terminalId: "term-1" }], locations: [],
};

test("acp_tool lifecycle: snapshot upserts, deltas merge, unknown ids become failed placeholders", () => {
  const blocks: MessageBlock[] = [];
  const ctx = newFoldCtx();
  foldBlock(blocks, { type: "acp_tool_call", call }, ctx);
  foldBlock(blocks, { type: "acp_tool_call", call: { ...call, title: "Run unit tests" } }, ctx); // re-sent snapshot
  expect(blocks).toHaveLength(1);
  foldBlock(blocks, { type: "acp_tool_update", delta: { id: "t1", status: "in_progress" } }, ctx);
  expect(blocks[0]).toMatchObject({ type: "acp_tool", call: { title: "Run unit tests", status: "in_progress" } });
  foldBlock(blocks, { type: "acp_tool_update", delta: { id: "ghost" } }, ctx);
  expect(blocks[1]).toMatchObject({ type: "acp_tool", call: { id: "ghost", status: "failed" } });
});

test("terminal output snapshots into the owning tool call at finalize; unfinished statuses settle to canceled", () => {
  const blocks: MessageBlock[] = [];
  const ctx = newFoldCtx();
  foldBlock(blocks, { type: "acp_tool_call", call }, ctx);
  foldBlock(blocks, { type: "term_output", terminalId: "term-1", chunk: "PASS " }, ctx);
  foldBlock(blocks, { type: "term_output", terminalId: "term-1", chunk: "3 tests" }, ctx);
  foldBlock(blocks, { type: "term_exit", terminalId: "term-1", exitCode: 0 }, ctx);
  finalizeToolBlocks(blocks, ctx);
  const b = blocks[0]!;
  if (b.type !== "acp_tool") throw new Error("wrong block");
  expect(b.call.content[0]).toEqual({ type: "terminal", terminalId: "term-1", output: "PASS 3 tests", exitCode: 0 });
  expect(b.call.status).toBe("canceled"); // never completed → settled, not stuck "pending"
});

test("oversized terminal output keeps the tail and is marked truncated", () => {
  const blocks: MessageBlock[] = [];
  const ctx = newFoldCtx();
  foldBlock(blocks, { type: "acp_tool_call", call }, ctx);
  foldBlock(blocks, { type: "term_output", terminalId: "term-1", chunk: "x".repeat(200_000) + "END" }, ctx);
  finalizeToolBlocks(blocks, ctx);
  const b = blocks[0]!;
  if (b.type !== "acp_tool" || b.call.content[0]?.type !== "terminal") throw new Error("wrong shape");
  const out = b.call.content[0].output!;
  expect(out.length).toBeLessThanOrEqual(128 * 1024 + 1);
  expect(out.startsWith("…")).toBe(true);
  expect(out.endsWith("END")).toBe(true);
});
