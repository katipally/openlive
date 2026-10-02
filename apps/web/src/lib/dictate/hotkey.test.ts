import { describe, expect, it } from "vitest";
import { bindingOf, hotkeyKeys, mayBeAltGr } from "./hotkey";

describe("hotkeyKeys", () => {
  it("names each key the way each platform does", () => {
    expect(hotkeyKeys("option_right", "darwin")).toEqual(["Right ⌥"]);
    expect(hotkeyKeys("option_right", "win32")).toEqual(["Right Alt"]);
    expect(hotkeyKeys("shift+option_right", "linux")).toEqual(["Shift", "Right Alt"]);
    expect(hotkeyKeys("command_right", "linux")).toEqual(["Right Super"]);
    expect(hotkeyKeys("ctrl_right", "darwin")).toEqual(["Right ⌃"]);
    expect(hotkeyKeys("capslock", "win32")).toEqual(["Caps Lock"]);
    expect(hotkeyKeys("f13", "darwin")).toEqual(["F13"]);
  });
});

describe("bindingOf", () => {
  it("writes held keys in ol-input's grammar, sides kept, in its order", () => {
    expect(bindingOf(["AltRight"])).toBe("option_right");
    expect(bindingOf(["AltRight", "ShiftLeft"])).toBe("option_right+shift_left");
    expect(bindingOf(["MetaRight", "ControlLeft"])).toBe("ctrl_left+command_right");
    expect(bindingOf(["CapsLock"])).toBe("capslock");
    expect(bindingOf(["F13"])).toBe("f13");
    expect(bindingOf(["ControlRight", "F24"])).toBe("ctrl_right+f24");
  });

  it("refuses a key that would also type into the app in front", () => {
    expect(bindingOf(["KeyA"])).toBeNull();
    expect(bindingOf(["AltRight", "KeyE"])).toBeNull();
    expect(bindingOf(["F5"])).toBeNull();
    expect(bindingOf(["F13", "F14"])).toBeNull();
    expect(bindingOf([])).toBeNull();
  });
});

it("warns about AltGr only where Right Alt can be it", () => {
  expect(mayBeAltGr("option_right", "win32")).toBe(true);
  expect(mayBeAltGr("option_right", "linux")).toBe(true);
  expect(mayBeAltGr("option_right", "darwin")).toBe(false);
  expect(mayBeAltGr("ctrl_right", "win32")).toBe(false);
});
