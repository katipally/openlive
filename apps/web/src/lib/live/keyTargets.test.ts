import { describe, expect, it } from "vitest";
import { isControlTarget, isTextTarget } from "./keyTargets";

const el = (tagName: string, attrs: Record<string, string> = {}, isContentEditable = false) =>
  ({ tagName, isContentEditable, getAttribute: (n: string) => attrs[n] ?? null });

describe("isTextTarget", () => {
  it("treats text fields, selects and editable regions as typing", () => {
    for (const t of ["INPUT", "TEXTAREA", "SELECT"]) expect(isTextTarget(el(t))).toBe(true);
    expect(isTextTarget(el("DIV", {}, true))).toBe(true);
  });
  it("leaves the page and buttons to shortcuts", () => {
    expect(isTextTarget(el("BODY"))).toBe(false);
    expect(isTextTarget(el("BUTTON"))).toBe(false);
    expect(isTextTarget(null)).toBe(false);
  });
});

describe("isControlTarget", () => {
  it("covers native controls and ARIA widgets", () => {
    expect(isControlTarget(el("BUTTON"))).toBe(true);
    expect(isControlTarget(el("A"))).toBe(true);
    expect(isControlTarget(el("DIV", { role: "switch" }))).toBe(true);
    expect(isControlTarget(el("SELECT"))).toBe(true);
  });
  it("lets the page body through", () => {
    expect(isControlTarget(el("BODY"))).toBe(false);
    expect(isControlTarget(el("DIV", { role: "region" }))).toBe(false);
    expect(isControlTarget(undefined)).toBe(false);
  });
});
