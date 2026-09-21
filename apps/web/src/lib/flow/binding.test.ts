// The capture field's half of the addon's binding vocabulary. What matters here
// is that a held modifier alone IS a binding, that the side is preserved, and
// that what comes out is a string `parseBinding` accepts (the canonical order is
// ctrl, option, shift, command, then the key).
import assert from "node:assert";
import { test } from "vitest";
import { bindingFromEvent, bindingLabel, isModifierOnly, keyName } from "./binding.ts";

const ev = (code: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) =>
  ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

test("a modifier held on its own is a binding", () => {
  assert.equal(bindingFromEvent(ev("ControlLeft", { ctrlKey: true })), "ctrl_left");
  assert.equal(bindingFromEvent(ev("AltRight", { altKey: true })), "option_right");
  assert.equal(isModifierOnly("option_right"), true);
  assert.equal(isModifierOnly("ctrl+shift"), true);
  assert.equal(isModifierOnly("option+space"), false);
});

test("a right modifier never also reports its left twin", () => {
  // The event carries altKey for BOTH sides; only the code says which one.
  assert.equal(bindingFromEvent(ev("AltRight", { altKey: true })), "option_right");
  assert.equal(bindingFromEvent(ev("ControlRight", { ctrlKey: true })), "ctrl_right");
});

test("modifiers already down join the chord, in canonical order", () => {
  assert.equal(bindingFromEvent(ev("ShiftLeft", { ctrlKey: true, shiftKey: true })), "ctrl_left+shift_left");
  assert.equal(bindingFromEvent(ev("Space", { ctrlKey: true, altKey: true })), "ctrl_left+option_left+space");
});

test("a key with no modifier is still a binding, and an unknown key is not", () => {
  assert.equal(bindingFromEvent(ev("KeyK")), "k");
  assert.equal(bindingFromEvent(ev("F13")), "f13");
  assert.equal(bindingFromEvent(ev("Digit7")), "num7");
  assert.equal(bindingFromEvent(ev("Unidentified")), "");
  assert.equal(keyName("BracketLeft"), "leftbracket");
});

test("a binding reads as what is printed on the keyboard", () => {
  // No window in this environment, so the non-mac spellings are the ones used.
  assert.equal(bindingLabel("option_right"), "Right Alt");
  assert.equal(bindingLabel("ctrl+shift+space"), "Ctrl + Shift + Space");
  assert.equal(bindingLabel("k"), "K");
  assert.equal(bindingLabel(""), "Not set");
  assert.equal(bindingLabel("   "), "Not set");
});
