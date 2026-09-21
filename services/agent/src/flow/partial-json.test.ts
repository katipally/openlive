import { describe, expect, it } from "vitest";
import { parsePartialJson } from "./partial-json.js";

describe("parsePartialJson", () => {
  it("returns {} for nothing at all", () => {
    expect(parsePartialJson("")).toEqual({});
    expect(parsePartialJson("   ")).toEqual({});
    expect(parsePartialJson("{")).toEqual({});
  });

  it("parses complete objects unchanged", () => {
    expect(parsePartialJson('{"text":"hi","n":2}')).toEqual({ text: "hi", n: 2 });
  });

  it("keeps a string value truncated mid-word", () => {
    expect(parsePartialJson('{"text":"dear ali')).toEqual({ text: "dear ali" });
  });

  it("keeps whitespace a fragment ended on, because it is content", () => {
    expect(parsePartialJson('{"text":"dear ')).toEqual({ text: "dear " });
    expect(parsePartialJson('{"n":1, ')).toEqual({ n: 1 });
  });

  it("drops a key whose value has not arrived", () => {
    expect(parsePartialJson('{"text":"hi","mode":')).toEqual({ text: "hi" });
  });

  it("drops a truncated key", () => {
    expect(parsePartialJson('{"text":"hi","mo')).toEqual({ text: "hi" });
    expect(parsePartialJson('{"te')).toEqual({});
  });

  it("drops a dangling comma", () => {
    expect(parsePartialJson('{"text":"hi",')).toEqual({ text: "hi" });
  });

  it("keeps a number that is still growing and repairs a half-written one", () => {
    expect(parsePartialJson('{"n":12')).toEqual({ n: 12 });
    expect(parsePartialJson('{"n":12.')).toEqual({ n: 12 });
    expect(parsePartialJson('{"n":-3.5e')).toEqual({ n: -3.5 });
  });

  it("drops a half-written literal", () => {
    expect(parsePartialJson('{"a":1,"ok":tru')).toEqual({ a: 1 });
    expect(parsePartialJson('{"ok":false}')).toEqual({ ok: false });
  });

  it("closes open arrays and nested objects", () => {
    expect(parsePartialJson('{"items":[1,2')).toEqual({ items: [1, 2] });
    expect(parsePartialJson('{"items":[{"a":1},{"b":')).toEqual({ items: [{ a: 1 }] });
    expect(parsePartialJson('{"a":{"b":{"c":"d')).toEqual({ a: { b: { c: "d" } } });
    expect(parsePartialJson('{"items":[')).toEqual({ items: [] });
  });

  it("drops an escape sequence cut in half", () => {
    expect(parsePartialJson('{"text":"line\\')).toEqual({ text: "line" });
    expect(parsePartialJson('{"text":"snow \\u26')).toEqual({ text: "snow " });
    expect(parsePartialJson('{"text":"a\\\\')).toEqual({ text: "a\\" });
  });

  it("keeps escapes that did arrive", () => {
    expect(parsePartialJson('{"text":"a\\nb"}')).toEqual({ text: "a\nb" });
    expect(parsePartialJson('{"text":"say \\"hi')).toEqual({ text: 'say "hi' });
  });

  it("handles unicode and emoji, including a split surrogate pair", () => {
    expect(parsePartialJson('{"text":"héllo 世界 👋')).toEqual({ text: "héllo 世界 👋" });
    expect(parsePartialJson('{"text":"wave \ud83d')).toEqual({ text: "wave " });
  });

  it("survives a brace inside a string value", () => {
    expect(parsePartialJson('{"text":"a } b')).toEqual({ text: "a } b" });
    expect(parsePartialJson('{"text":"{\\"x\\":1}"}')).toEqual({ text: '{"x":1}' });
  });

  it("grows monotonically as fragments arrive", () => {
    const full = '{"text":"hello there","n":3}';
    let last = "";
    for (let i = 1; i <= full.length; i++) {
      const t = parsePartialJson(full.slice(0, i)).text;
      if (typeof t !== "string") continue;
      expect(t.startsWith(last) || last.startsWith(t)).toBe(true);
      if (t.length > last.length) last = t;
    }
    expect(last).toBe("hello there");
  });

  it("refuses anything that is not an object", () => {
    expect(parsePartialJson("[1,2")).toEqual({});
    expect(parsePartialJson('"just text"')).toEqual({});
    expect(parsePartialJson("garbage")).toEqual({});
  });
});
