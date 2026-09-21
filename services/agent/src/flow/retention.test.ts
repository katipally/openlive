import { describe, expect, it } from "vitest";
import { trimImages } from "./retention.js";
import type { Msg } from "./types.js";

const shot = (id: string): Msg[] => [
  { role: "assistant", toolCalls: [{ id, name: "screenshot", arguments: "{}" }] },
  { role: "tool", callId: id, name: "screenshot", result: "the screen", images: [{ data: "PNG", mime: "image/png" }] },
];

/** The bug this whole file exists for: a call with no result, or a result with no call. */
function orphans(messages: Msg[]): string[] {
  const called = new Set<string>();
  for (const m of messages) if (m.role === "assistant") for (const c of m.toolCalls ?? []) called.add(c.id);
  const answered = new Set<string>();
  for (const m of messages) if (m.role === "tool") answered.add(m.callId);
  return [
    ...[...called].filter((id) => !answered.has(id)),
    ...[...answered].filter((id) => !called.has(id)),
  ];
}

describe("trimImages", () => {
  it("leaves a transcript alone while it is under the limit", () => {
    const messages: Msg[] = [{ role: "user", text: "hi" }, ...shot("a"), ...shot("b")];
    expect(trimImages(messages, 2)).toBeNull();
  });

  it("drops the oldest screenshots with their calls, leaving no orphan", () => {
    const messages: Msg[] = [{ role: "user", text: "go" }, ...shot("a"), ...shot("b"), ...shot("c"), ...shot("d")];
    const out = trimImages(messages, 2)!;
    expect(orphans(out)).toEqual([]);
    expect(out.some((m) => m.role === "tool" && m.callId === "a")).toBe(false);
    expect(out.some((m) => m.role === "tool" && m.callId === "d")).toBe(true);
    expect(orphans(messages)).toEqual([]);
  });

  it("keeps the rest of an assistant message when only one of its calls goes", () => {
    const messages: Msg[] = [
      { role: "assistant", text: "looking", toolCalls: [{ id: "a", name: "screenshot", arguments: "{}" }, { id: "x", name: "get_context", arguments: "{}" }] },
      { role: "tool", callId: "a", name: "screenshot", result: "screen", images: [{ data: "PNG", mime: "image/png" }] },
      { role: "tool", callId: "x", name: "get_context", result: "Mail" },
      ...shot("b"), ...shot("c"), ...shot("d"),
    ];
    const out = trimImages(messages, 2)!;
    expect(orphans(out)).toEqual([]);
    const assistant = out.find((m) => m.role === "assistant" && m.text === "looking");
    expect(assistant).toMatchObject({ toolCalls: [{ id: "x" }] });
    expect(out.some((m) => m.role === "tool" && m.callId === "x")).toBe(true);
  });

  it("drops an assistant message that was nothing but the dropped call", () => {
    const messages: Msg[] = [...shot("a"), ...shot("b"), ...shot("c")];
    const out = trimImages(messages, 1)!;
    expect(out).toHaveLength(2);
    expect(orphans(out)).toEqual([]);
  });

  it("no trim of any size can orphan a call", () => {
    const messages: Msg[] = [{ role: "user", text: "go" }, ...shot("a"), ...shot("b"), ...shot("c"), ...shot("d"), ...shot("e")];
    for (let keep = 0; keep <= 5; keep++) {
      const out = trimImages(messages, keep) ?? messages;
      expect(orphans(out)).toEqual([]);
    }
  });
});
