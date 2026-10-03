import { describe, expect, it } from "vitest";
import { bindingOf, hotkeyKeys, keyIssue, keyName, liveKeys, mayBeAltGr, narrowNote, pickKey, type Talk } from "./hotkey";

describe("hotkeyKeys", () => {
  it("names each key the way each platform does", () => {
    expect(hotkeyKeys("option_right", "darwin")).toEqual(["Right ⌥"]);
    expect(hotkeyKeys("option_right", "win32")).toEqual(["Right Alt"]);
    expect(hotkeyKeys("shift+option_right", "linux")).toEqual(["Shift", "Right Alt"]);
    expect(hotkeyKeys("command_right", "linux")).toEqual(["Right Super"]);
    expect(hotkeyKeys("ctrl_right", "darwin")).toEqual(["Right ⌃"]);
    expect(hotkeyKeys("fn", "darwin")).toEqual(["Fn"]);
    expect(hotkeyKeys("f13", "darwin")).toEqual(["F13"]);
  });
});

describe("bindingOf", () => {
  it("writes held keys in ol-input's grammar, sides kept, in its order", () => {
    expect(bindingOf(["AltRight"])).toBe("option_right");
    expect(bindingOf(["AltRight", "ShiftLeft"])).toBe("option_right+shift_left");
    expect(bindingOf(["MetaRight", "ControlLeft"])).toBe("ctrl_left+command_right");
    expect(bindingOf(["F13"])).toBe("f13");
    expect(bindingOf(["ControlRight", "F24"])).toBe("ctrl_right+f24");
    expect(bindingOf(["Fn"])).toBe("fn");
  });

  it("refuses a key that would also type into the app in front", () => {
    expect(bindingOf(["KeyA"])).toBeNull();
    expect(bindingOf(["AltRight", "KeyE"])).toBeNull();
    expect(bindingOf(["CapsLock"])).toBeNull();
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

it("names a key in words for a sentence", () => {
  expect(keyName("ctrl_left", "darwin")).toBe("Left Control");
  expect(keyName("ctrl_left", "win32")).toBe("Left Ctrl");
  expect(keyName("option", "darwin")).toBe("Option");
  expect(keyName("command_right", "linux")).toBe("Right Super");
  expect(keyName("fn", "darwin")).toBe("Fn");
});

describe("the talk keys beside each other", () => {
  const talk: Talk = { mode: "ptt", pttKey: "ctrl_right", flowKey: "ctrl", dictateKey: "option", closeAfterSilenceMs: 30_000 };

  it("narrows a double-tap key away from push to talk, in push to talk only", () => {
    expect(liveKeys(talk)).toEqual({ flow: "ctrl_left", dictate: "option", ptt: "ctrl_right" });
    expect(liveKeys({ ...talk, mode: "handsFree" }).flow).toBe("ctrl");
    expect(narrowNote("flowKey", talk, "win32")).toBe("Flow uses Left Ctrl only, since Push to talk is Right Ctrl.");
    expect(narrowNote("flowKey", { ...talk, mode: "handsFree" }, "linux")).toMatch(/^In Push to talk, Flow uses Left Ctrl only/);
    expect(narrowNote("dictateKey", talk, "win32")).toBe("");
  });

  it("refuses a key that clashes, and says which key it clashes with", () => {
    expect(keyIssue("dictateKey", "ctrl_left", talk, "win32")).toBe("Flow opens with Ctrl. Pick another key.");
    expect(keyIssue("flowKey", "ctrl_right", talk, "win32")).toBe("Push to talk is Right Ctrl, which would leave Flow no key. Pick another.");
    expect(keyIssue("pttKey", "option_left", { ...talk, dictateKey: "option_left" }, "win32")).toMatch(/^Dictate opens with Left Alt/);
    expect(keyIssue("pttKey", "fn", talk, "linux")).toMatch(/^Fn never reaches/);
    expect(keyIssue("pttKey", "fn", talk, "darwin")).toBeNull();
    expect(keyIssue("pttKey", "ctrl", talk, "win32")).toBe("Pick one side, like Right Ctrl.");
    expect(keyIssue("pttKey", "capslock", talk, "darwin")).toMatch(/Fn, or F13 to F24\.$/);
    expect(keyIssue("flowKey", "f19", talk, "win32")).toBeNull();
  });

  it("takes a double-tapped modifier on either side unless only its own side is free", () => {
    expect(pickKey("dictateKey", "option_right", talk, "win32")).toEqual({ key: "option" });
    expect(pickKey("dictateKey", "ctrl_right", { ...talk, mode: "handsFree", pttKey: "f18", flowKey: "ctrl_left" }, "win32")).toEqual({ key: "ctrl_right" });
    expect(pickKey("pttKey", "ctrl_left", { ...talk, flowKey: "f19" }, "win32")).toEqual({ key: "ctrl_left" });
    expect(pickKey("flowKey", null, talk, "darwin")).toEqual({ issue: expect.stringMatching(/like Control or Option/) });
    expect(pickKey("dictateKey", "ctrl_left", talk, "win32")).toEqual({ issue: "Flow opens with Ctrl. Pick another key." });
    expect(pickKey("flowKey", "ctrl_right", talk, "win32")).toEqual({ issue: "Push to talk is Right Ctrl, which would leave Flow no key. Pick another." });
  });
});
