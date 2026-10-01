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

  it("strips the oldest pictures but keeps every call and its result text", () => {
    const messages: Msg[] = [{ role: "user", text: "go" }, ...shot("a"), ...shot("b"), ...shot("c"), ...shot("d")];
    const out = trimImages(messages, 2)!;
    expect(out).toHaveLength(messages.length);
    expect(orphans(out)).toEqual([]);
    expect(out[2]).toEqual({ role: "tool", callId: "a", name: "screenshot", result: "the screen\n[screenshot removed]", images: undefined });
    expect(out.filter((m) => m.role === "assistant")).toEqual(messages.filter((m) => m.role === "assistant"));
    expect(out.filter((m) => m.role === "tool" && m.images?.length).map((m) => (m as { callId: string }).callId)).toEqual(["c", "d"]);
    expect(messages[2]).toMatchObject({ images: [{ data: "PNG" }] });
  });

  it("leaves a placeholder where a picture had no text with it", () => {
    const messages: Msg[] = [
      { role: "assistant", toolCalls: [{ id: "a", name: "click", arguments: "{}" }] },
      { role: "tool", callId: "a", name: "click", result: "", images: [{ data: "PNG", mime: "image/png" }] },
      ...shot("b"),
    ];
    expect(trimImages(messages, 1)![1]).toMatchObject({ result: "[screenshot removed]", images: undefined });
  });

  it("keeps the default of three screenshots", () => {
    const messages: Msg[] = [...shot("a"), ...shot("b"), ...shot("c"), ...shot("d")];
    expect(trimImages(messages)!.filter((m) => m.role === "tool" && m.images?.length)).toHaveLength(3);
  });

  it("no trim of any size can orphan a call", () => {
    const messages: Msg[] = [{ role: "user", text: "go" }, ...shot("a"), ...shot("b"), ...shot("c"), ...shot("d"), ...shot("e")];
    for (let keep = 0; keep <= 5; keep++) {
      const out = trimImages(messages, keep) ?? messages;
      expect(orphans(out)).toEqual([]);
    }
  });
});
