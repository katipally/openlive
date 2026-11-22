import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const { ZOOM_STEPS, sameZoom, sanitizeZoom, nextZoom, zoomKeyAction, legacyHostZoom } = createRequire(import.meta.url)("./zoom.cjs");

describe("ZOOM_STEPS", () => {
  it("run from 75 to 300 percent, ascending, with 100 among them", () => {
    expect(ZOOM_STEPS[0]).toBe(0.75);
    expect(ZOOM_STEPS.at(-1)).toBe(3);
    expect(ZOOM_STEPS).toContain(1);
    expect([...ZOOM_STEPS].sort((a: number, b: number) => a - b)).toEqual(ZOOM_STEPS);
  });
});

describe("sanitizeZoom", () => {
  it("keeps a step as it is", () => {
    for (const s of ZOOM_STEPS) expect(sanitizeZoom(s)).toBe(s);
  });
  it("snaps anything else to the nearest step, held inside the range", () => {
    expect(sanitizeZoom(1.12)).toBe(1.1);
    expect(sanitizeZoom(1.4)).toBe(1.5);
    expect(sanitizeZoom(0.1)).toBe(0.75);
    expect(sanitizeZoom(-4)).toBe(0.75);
    expect(sanitizeZoom(50)).toBe(3);
    expect(sanitizeZoom(Infinity)).toBe(1);
  });
  it("answers 100 percent for what is not a number", () => {
    for (const v of [NaN, undefined, null, "1.5", {}, [], true]) expect(sanitizeZoom(v)).toBe(1);
  });
});

describe("sameZoom", () => {
  it("forgives the logarithm's rounding and nothing near a step", () => {
    expect(sameZoom(1.1, 1.1000000000000003)).toBe(true);
    expect(sameZoom(1, 1.1)).toBe(false);
  });
});

describe("nextZoom", () => {
  it("moves one step at a time", () => {
    expect(nextZoom(1, "in")).toBe(1.1);
    expect(nextZoom(1, "out")).toBe(0.9);
    expect(nextZoom(0.9, "out")).toBe(0.75);
    expect(nextZoom(2, "in")).toBe(2.5);
  });
  it("holds at the ends", () => {
    expect(nextZoom(3, "in")).toBe(3);
    expect(nextZoom(0.75, "out")).toBe(0.75);
  });
  it("goes to the next step from between two, and from outside the range", () => {
    expect(nextZoom(1.05, "in")).toBe(1.1);
    expect(nextZoom(1.05, "out")).toBe(1);
    expect(nextZoom(5, "in")).toBe(3);
    expect(nextZoom(5, "out")).toBe(3);
    expect(nextZoom(0.5, "in")).toBe(0.75);
    expect(nextZoom(0.5, "out")).toBe(0.75);
  });
  it("is not thrown by a factor read back a hair off its step", () => {
    expect(nextZoom(1.1000000000000003, "in")).toBe(1.25);
    expect(nextZoom(1.0999999999999999, "out")).toBe(1);
  });
  it("resets to 100 percent from anywhere, and treats a broken current as 100", () => {
    for (const c of [0.75, 1, 1.37, 3, NaN, undefined]) expect(nextZoom(c, "reset")).toBe(1);
    expect(nextZoom(NaN, "in")).toBe(1.1);
    expect(nextZoom(undefined, "out")).toBe(0.9);
  });
  it("snaps for an action it does not know", () => {
    expect(nextZoom(1.4, "sideways")).toBe(1.5);
  });
});

describe("zoomKeyAction", () => {
  const key = (o: object) => ({ type: "keyDown", key: "", code: "", control: false, meta: false, shift: false, alt: false, ...o });
  const ctrl = (o: object) => key({ control: true, ...o });
  const cmd = (o: object) => key({ meta: true, ...o });

  it("reads Ctrl on Windows and Linux", () => {
    for (const p of ["win32", "linux"]) {
      expect(zoomKeyAction(ctrl({ key: "=", code: "Equal" }), p)).toBe("in");
      expect(zoomKeyAction(ctrl({ key: "+", code: "Equal", shift: true }), p)).toBe("in");
      expect(zoomKeyAction(ctrl({ key: "-", code: "Minus" }), p)).toBe("out");
      expect(zoomKeyAction(ctrl({ key: "_", code: "Minus", shift: true }), p)).toBe("out");
      expect(zoomKeyAction(ctrl({ key: "0", code: "Digit0" }), p)).toBe("reset");
    }
  });
  it("reads Cmd on a Mac", () => {
    expect(zoomKeyAction(cmd({ key: "=", code: "Equal" }), "darwin")).toBe("in");
    expect(zoomKeyAction(cmd({ key: "-", code: "Minus" }), "darwin")).toBe("out");
    expect(zoomKeyAction(cmd({ key: "0", code: "Digit0" }), "darwin")).toBe("reset");
  });
  it("reads the numpad by its code, with NumLock on or off", () => {
    expect(zoomKeyAction(ctrl({ key: "+", code: "NumpadAdd" }), "win32")).toBe("in");
    expect(zoomKeyAction(ctrl({ key: "-", code: "NumpadSubtract" }), "win32")).toBe("out");
    expect(zoomKeyAction(ctrl({ key: "0", code: "Numpad0" }), "win32")).toBe("reset");
    expect(zoomKeyAction(ctrl({ key: "Insert", code: "Numpad0" }), "win32")).toBe("reset");
    expect(zoomKeyAction(cmd({ key: "+", code: "NumpadAdd" }), "darwin")).toBe("in");
  });
  it("finds a layout's own plus and minus by what they type", () => {
    expect(zoomKeyAction(ctrl({ key: "+", code: "BracketRight" }), "linux")).toBe("in");
    expect(zoomKeyAction(ctrl({ key: "-", code: "Slash" }), "linux")).toBe("out");
  });
  it("finds reset on the 0 key of a layout that types something else there", () => {
    expect(zoomKeyAction(ctrl({ key: "à", code: "Digit0" }), "win32")).toBe("reset");
    expect(zoomKeyAction(ctrl({ key: "0", code: "Digit0", shift: true }), "linux")).toBe("reset");
  });
  it("does not read the Equal and Minus keys by position", () => {
    expect(zoomKeyAction(ctrl({ key: "´", code: "Equal" }), "linux")).toBeNull();
    expect(zoomKeyAction(ctrl({ key: "ß", code: "Minus" }), "linux")).toBeNull();
  });
  it("needs the platform's modifier and no other", () => {
    expect(zoomKeyAction(key({ key: "=" }), "win32")).toBeNull();
    expect(zoomKeyAction(cmd({ key: "=" }), "win32")).toBeNull();
    expect(zoomKeyAction(ctrl({ key: "=" }), "darwin")).toBeNull();
    expect(zoomKeyAction(key({ key: "=", control: true, meta: true }), "darwin")).toBeNull();
    // AltGr arrives as Ctrl+Alt on Windows and types characters.
    expect(zoomKeyAction(ctrl({ key: "-", alt: true }), "win32")).toBeNull();
  });
  it("answers a press, not its release, and no other key", () => {
    expect(zoomKeyAction(ctrl({ type: "keyUp", key: "=" }), "win32")).toBeNull();
    expect(zoomKeyAction(ctrl({ key: "r", code: "KeyR" }), "win32")).toBeNull();
    expect(zoomKeyAction(ctrl({ key: "1", code: "Digit1" }), "win32")).toBeNull();
  });
});

describe("legacyHostZoom", () => {
  const prefs = (hosts: object, part = "1234567") => ({ partition: { per_host_zoom_levels: { [part]: hosts } } });

  it("turns Chromium's saved level into the nearest step", () => {
    expect(legacyHostZoom(prefs({ localhost: 1 }), "localhost")).toBe(1.25);
    expect(legacyHostZoom(prefs({ localhost: 3 }), "localhost")).toBe(1.75);
    expect(legacyHostZoom(prefs({ localhost: -1 }), "localhost")).toBe(0.9);
    expect(legacyHostZoom(prefs({ localhost: -9 }), "localhost")).toBe(0.75);
    expect(legacyHostZoom(prefs({ localhost: 5 }), "localhost")).toBe(2.5);
    expect(legacyHostZoom(prefs({ localhost: 99 }), "localhost")).toBe(3);
  });
  it("reads the host from whichever partition holds it", () => {
    const p = { partition: { per_host_zoom_levels: { a: { "example.com": 2 }, b: { localhost: 2 } } } };
    expect(legacyHostZoom(p, "localhost")).toBe(1.5);
  });
  it("answers null when there is nothing usable to carry over", () => {
    for (const p of [undefined, null, "x", 3, [], {}, { partition: null }, { partition: {} }, { partition: { per_host_zoom_levels: "x" } },
      { partition: { per_host_zoom_levels: { a: null } } }, prefs({}), prefs({ "example.com": 2 }),
      prefs({ localhost: "2" }), prefs({ localhost: NaN }), prefs({ localhost: null })]) {
      expect(legacyHostZoom(p, "localhost")).toBeNull();
    }
  });
});
