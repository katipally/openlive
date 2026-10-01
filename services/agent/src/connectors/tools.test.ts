import { describe, expect, it } from "vitest";
import { exposedNames, toResult, RESULT_IMAGES_MAX, RESULT_TEXT_MAX } from "./tools.js";

const tool = (name: string) => ({ name, description: "", inputSchema: {}, readOnly: false });
const row = (slug: string, ...tools: string[]) => ({ slug, tools: tools.map(tool) });

describe("exposed tool names", () => {
  it("are <slug>__<tool>, cleaned to what providers accept", () => {
    const n = exposedNames([row("github", "create_issue", "search.code", "läuft")]);
    expect([...n.get("github")!.values()]).toEqual(["github__create_issue", "github__l_uft", "github__search_code"]);
    for (const name of n.get("github")!.values()) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it("fit in 64 characters, the long ones still told apart", () => {
    const long = "x".repeat(80);
    const n = exposedNames([row("svc", `${long}a`, `${long}b`)]).get("svc")!;
    const [a, b] = [n.get(`${long}a`)!, n.get(`${long}b`)!];
    expect(a.length).toBeLessThanOrEqual(64);
    expect(b.length).toBeLessThanOrEqual(64);
    expect(a).not.toBe(b);
  });

  it("settle a collision the same way whatever order the tools arrive in", () => {
    const one = exposedNames([row("a", "foo.bar", "foo_bar")]).get("a")!;
    const two = exposedNames([row("a", "foo_bar", "foo.bar")]).get("a")!;
    expect(one).toEqual(two);
    expect(new Set(one.values()).size).toBe(2);
    expect(one.get("foo.bar")).toBe("a__foo_bar");
    expect(one.get("foo_bar")).toMatch(/^a__foo_bar_[0-9a-f]{6}$/);
  });

  it("do not depend on the order connectors are listed in", () => {
    const rows = [row("zeta", "a", "b"), row("alpha", "a".repeat(70), "b")];
    expect(exposedNames(rows)).toEqual(exposedNames([...rows].reverse()));
  });
});

describe("a connector's result", () => {
  it("keeps text and pictures, and spells out links, resources and audio", () => {
    const r = toResult({ content: [
      { type: "text", text: "hello" },
      { type: "image", data: "AAAA", mimeType: "image/jpeg" },
      { type: "resource_link", uri: "https://x.example/a", name: "a" },
      { type: "resource", resource: { uri: "file:///b.txt", text: "inside b" } },
      { type: "resource", resource: { uri: "file:///c.bin", blob: "AAAA", mimeType: "application/zip" } },
      { type: "audio", data: "AAAA", mimeType: "audio/wav" },
    ] });
    expect(r.content).toEqual([
      { type: "text", text: "hello" },
      { type: "image", data: "AAAA", mime: "image/jpeg" },
      { type: "text", text: "Resource: a <https://x.example/a>" },
      { type: "text", text: "inside b" },
      { type: "text", text: "[application/zip resource <file:///c.bin>]" },
      { type: "text", text: "[audio/wav audio, not shown]" },
    ]);
  });

  it(`is capped at ${RESULT_TEXT_MAX} characters across every part`, () => {
    const big = "y".repeat(RESULT_TEXT_MAX - 10);
    const r = toResult({ content: [{ type: "text", text: big }, { type: "text", text: "z".repeat(100) }, { type: "text", text: "gone" }] });
    const texts = r.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text);
    expect(texts.join("").replace(/\n\[cut:[^\]]+\]/g, "").length).toBe(RESULT_TEXT_MAX);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain("[cut:");
  });

  it(`keeps at most ${RESULT_IMAGES_MAX} pictures and says how many it left out`, () => {
    const r = toResult({ content: Array.from({ length: 6 }, () => ({ type: "image" as const, data: "AAAA", mimeType: "image/png" })) });
    expect(r.content.filter((c) => c.type === "image")).toHaveLength(RESULT_IMAGES_MAX);
    expect(r.content.at(-1)).toEqual({ type: "text", text: "[2 more images left out]" });
  });

  it("falls back to structured content, then to saying there was none", () => {
    expect(toResult({ content: [], structuredContent: { n: 1 } }).content).toEqual([{ type: "text", text: '{"n":1}' }]);
    expect(toResult({ content: [] }).content).toEqual([{ type: "text", text: "(no output)" }]);
  });
});
