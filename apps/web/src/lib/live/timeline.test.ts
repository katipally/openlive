import { describe, expect, it } from "vitest";
import type { Part } from "@/lib/chatStore";
import type { ToolCallState } from "@openlive/shared";
import { formatDuration, segmentTurn, summarizeWork } from "./timeline";

const call = (id: string, kind: ToolCallState["kind"]): ToolCallState => ({ id, title: id, kind, status: "completed", content: [], locations: [] });
const acp = (id: string, kind: ToolCallState["kind"], at?: number): Part => ({ kind: "acp_tool", call: call(id, kind), at });
const tool = (name: string, at?: number): Part => ({ kind: "tool", tool: name, done: true, at });
const think = (text: string, at?: number): Part => ({ kind: "reasoning", text, at });
const say = (text: string, at?: number): Part => ({ kind: "text", text, at });

describe("segmentTurn", () => {
  it("folds quiet work into one group, timed from its first step to what follows", () => {
    const segs = segmentTurn([think("hmm", 1000), acp("r1", "read", 1500), acp("r2", "read", 2000), say("Found it.", 4000)], 9000);
    expect(segs).toEqual([
      { kind: "work", parts: [think("hmm", 1000), acp("r1", "read", 1500), acp("r2", "read", 2000)], startedAt: 1000, endedAt: 4000 },
      { kind: "text", text: "Found it." },
    ]);
  });

  it("lets an edit stand on its own, splitting the work around it", () => {
    const segs = segmentTurn([acp("r1", "read", 1), acp("s1", "search", 2), acp("e1", "edit", 3), acp("x1", "execute", 4), acp("x2", "execute", 5)], 6);
    expect(segs.map((s) => s.kind)).toEqual(["work", "step", "work"]);
    expect(segs[0]).toMatchObject({ startedAt: 1, endedAt: 3 });
    expect(segs[2]).toMatchObject({ startedAt: 4, endedAt: 6 });
  });

  it("shows a lone tool as its own row, but keeps lone reasoning a group", () => {
    expect(segmentTurn([tool("look"), say("A cat.")])).toEqual([{ kind: "step", part: tool("look") }, { kind: "text", text: "A cat." }]);
    expect(segmentTurn([think("so")])[0]!.kind).toBe("work");
  });

  it("leaves a still-running trailing group open-ended and an empty turn empty", () => {
    expect(segmentTurn([tool("web_search", 5), tool("fetch_url", 6)])[0]).toMatchObject({ kind: "work", startedAt: 5, endedAt: undefined });
    expect(segmentTurn([])).toEqual([]);
  });
});

describe("summarizeWork", () => {
  it("names the dominant action and flags a mix", () => {
    expect(summarizeWork([acp("a", "read"), acp("b", "read"), acp("c", "search")] as never)).toEqual({ label: "Read 2 files", multiKind: true });
    expect(summarizeWork([tool("web_search")] as never)).toEqual({ label: "Searched 1 time", multiKind: false });
    expect(summarizeWork([])).toEqual({ label: "Worked on it", multiKind: false });
  });
});

describe("formatDuration", () => {
  it("reads short, medium and long spans", () => {
    expect(formatDuration(40)).toBe("0.1s");
    expect(formatDuration(2340)).toBe("2.3s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(185_000)).toBe("3m 5s");
  });
});
