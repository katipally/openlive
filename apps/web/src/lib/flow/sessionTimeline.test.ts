import { describe, expect, it } from "vitest";
import type { FlowSessionEntry } from "./sessions";
import { flowTimeline, startsTurn, timelineText, type FlowItem } from "./sessionTimeline";

let seq = 0;
const at = (s: number) => new Date(Date.UTC(2026, 8, 27, 12, 0, s)).toISOString();
const e = (type: string, s: number, rest: Record<string, unknown> = {}): FlowSessionEntry =>
  ({ id: `e${++seq}`, parentId: null, seq, timestamp: at(s), type, ...rest });

describe("flowTimeline", () => {
  it("merges a call and its result into one row, with only the arguments that say something", () => {
    const { items, tools } = flowTimeline([
      e("message", 0, { role: "user", text: "What is on screen?" }),
      e("tool_call", 1, { callId: "c1", name: "screenshot", args: {} }),
      e("tool_result", 3, { callId: "c1", name: "screenshot", isError: false, assets: ["assets/c1-0.png", "assets/gone.png"] }),
      e("message", 4, { role: "assistant", text: "A cat." }),
    ], [{ name: "c1-0.png" }]);
    expect(items.map((i) => i.kind)).toEqual(["user", "tools", "reply"]);
    expect(tools.size).toBe(1);
    expect(tools.get("c1")).toMatchObject({ label: "Looked at the screen", status: "done", ms: 2000, shots: ["c1-0.png"] });
    expect(tools.get("c1")!.args).toBeUndefined();
    const tl = items[1]!;
    expect(tl.kind === "tools" && tl.segments).toEqual([{ kind: "step", part: expect.objectContaining({ id: "c1", done: true }) }]);
  });

  it("folds a run of tools into one group and keeps each outcome", () => {
    const { items, tools } = flowTimeline([
      e("tool_call", 0, { callId: "a", name: "click", args: { x: 4, y: 9, note: "" } }),
      e("tool_result", 1, { callId: "a", name: "click", isError: true, declined: true }),
      e("tool_call", 2, { callId: "b", name: "type", args: { text: "hi" } }),
      e("tool_result", 3, { callId: "b", name: "type", isError: true }),
    ], []);
    const tl = items[0]!;
    expect(tl.kind === "tools" && tl.segments.map((s) => s.kind)).toEqual(["work"]);
    expect(tools.get("a")).toMatchObject({ status: "declined", args: [["x", "4"], ["y", "9"]] });
    expect(tools.get("b")!.status).toBe("failed");
  });

  it("notes the app only when it changes, and never an empty one", () => {
    const ctx = (s: number, app: string) => e("context", s, { context: { app, windowTitle: "t" } });
    const { items } = flowTimeline([ctx(0, "Safari"), e("message", 1, { role: "user", text: "hi" }), ctx(2, "Safari"), ctx(3, ""), ctx(4, "Mail")], []);
    expect(items.map((i) => (i.kind === "app" ? i.app : i.kind))).toEqual(["Safari", "user", "Mail"]);
  });

  it("marks a spoken reply apart from a quiet one, skips empty lines, and survives nothing at all", () => {
    const { items } = flowTimeline([
      e("message", 0, { role: "assistant", text: "Said." }),
      e("message", 1, { role: "assistant", text: "Shown.", quiet: true }),
      e("message", 2, { role: "user", text: "  " }),
      e("cancel", 3, { n: 1 }),
      e("compaction", 4),
    ], []);
    expect(items).toMatchObject([{ kind: "reply", spoken: true }, { kind: "reply", spoken: false }, { kind: "stop" }]);
    expect(flowTimeline([], []).items).toEqual([]);
  });

  it("copies as plain lines without raw arguments", () => {
    const tl = flowTimeline([
      e("message", 0, { role: "user", text: "Go" }),
      e("tool_call", 1, { callId: "c", name: "wait", args: {} }),
    ], []);
    expect(timelineText(tl, () => "t")).toBe("t  You: Go\n  Waited for the screen: never finished");
  });

  it("stays linear on a long session", () => {
    const many = Array.from({ length: 4000 }, (_, i) => i % 2
      ? e("tool_result", i, { callId: `c${i - 1}`, name: "click", isError: false })
      : e("tool_call", i, { callId: `c${i}`, name: "click", args: { x: i } }));
    const t0 = performance.now();
    const { tools } = flowTimeline(many, []);
    expect(tools.size).toBe(2000);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe("startsTurn", () => {
  const it_ = (kind: FlowItem["kind"]) => ({ kind }) as FlowItem;
  it("puts a turn between speakers and a beat within one", () => {
    expect(startsTurn(it_("reply"), it_("user"))).toBe(true);
    expect(startsTurn(it_("user"), it_("tools"))).toBe(true);
    expect(startsTurn(it_("user"), it_("reply"))).toBe(true);
    expect(startsTurn(it_("tools"), it_("reply"))).toBe(false);
    expect(startsTurn(it_("reply"), it_("tools"))).toBe(false);
    expect(startsTurn(it_("tools"), it_("stop"))).toBe(false);
  });

  it("keeps an app change with what was said in it", () => {
    expect(startsTurn(it_("reply"), it_("app"))).toBe(true);
    expect(startsTurn(it_("app"), it_("user"))).toBe(false);
  });
});
