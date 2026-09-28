import { describe, expect, it } from "vitest";
import { isKeyboardFocus, modalityOf } from "./focus";

const el = (visible: boolean | "throws") => ({
  matches: (s: string) => { if (visible === "throws") throw new SyntaxError(s); return s === ":focus-visible" && visible; },
}) as unknown as Element;

describe("input modality", () => {
  it("a plain key is the keyboard, a press is the pointer", () => {
    expect(modalityOf({ type: "keydown" })).toBe("keyboard");
    expect(modalityOf({ type: "keydown", shiftKey: true } as never)).toBe("keyboard");
    expect(modalityOf({ type: "pointerdown" })).toBe("pointer");
  });

  it("a chord or any other event leaves the modality alone", () => {
    for (const mod of ["metaKey", "ctrlKey", "altKey"]) expect(modalityOf({ type: "keydown", [mod]: true })).toBeNull();
    expect(modalityOf({ type: "focus" })).toBeNull();
  });
});

describe("keyboard focus", () => {
  it("needs both a keyboard last and :focus-visible", () => {
    expect(isKeyboardFocus(el(true), "keyboard")).toBe(true);
    expect(isKeyboardFocus(el(false), "keyboard")).toBe(false);
  });

  it("never counts focus that follows a pointer press, even when the engine calls it visible", () => {
    expect(isKeyboardFocus(el(true), "pointer")).toBe(false);
  });

  it("trusts the modality where :focus-visible is unsupported", () => {
    expect(isKeyboardFocus(el("throws"), "keyboard")).toBe(true);
    expect(isKeyboardFocus(el("throws"), "pointer")).toBe(false);
  });
});
