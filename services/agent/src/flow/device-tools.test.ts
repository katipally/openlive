import { describe, expect, it } from "vitest";
import { deviceTools } from "./device-tools.js";
import type { CapabilityReport, ControlAction, DevicePort, ShotGeometry, ShotPoint } from "./device.js";
import type { Tool, ToolCtx } from "./types.js";

const CAPS: CapabilityReport = {
  hook: true, postEvents: true, injection: "paste", capture: true, captureBackend: "screencapturekit",
  ocr: true, ocrEngine: "vision", selection: true, selectionBackend: "ax",
  windowControl: true, elevatedWindowInjection: true, secureInput: false, tools: [],
};

const SHOT: ShotGeometry = { originX: 100, originY: 50, scale: 0.5, width: 1024, height: 768 };

function fakeDevice(over: Partial<DevicePort> & { caps?: Partial<CapabilityReport> } = {}) {
  const actions: ControlAction[] = [];
  const converted: Array<{ shot: ShotGeometry; point: ShotPoint }> = [];
  const device: DevicePort = {
    capabilities: async () => ({ ...CAPS, ...over.caps }),
    displays: async () => [{ id: 1, name: "main", x: 0, y: 0, width: 1920, height: 1080, scale: 2, primary: true }],
    capture: async () => ({ png: "PNGDATA", shot: SHOT }),
    // The addon's arithmetic, standing in for the addon. Nothing in the tool
    // layer is allowed to know this formula.
    shotToScreen: async (shot, point) => {
      converted.push({ shot, point });
      return { space: "screen", x: shot.originX + point.x / shot.scale, y: shot.originY + point.y / shot.scale };
    },
    recognizeText: async () => [{ text: "Send", confidence: 1, x: 500, y: 250, width: 40, height: 20 }],
    windows: async () => [{ id: 7, appName: "Mail", pid: 3, x: 0, y: 0, width: 800, height: 600, minimized: false }],
    foreground: async () => ({ id: 7, appName: "Mail", pid: 3, x: 0, y: 0, width: 800, height: 600, minimized: false }),
    cameraFrame: async () => ({ data: "JPEG", mime: "image/jpeg" }),
    control: async (a) => { actions.push(a); },
    shell: async () => ({ code: 0, stdout: "ok", stderr: "" }),
    ...over,
  };
  return { device, actions, converted };
}

const ctx = {} as ToolCtx;
const byName = (tools: Tool[], name: string): Tool => tools.find((t) => t.name === name)!;
const build = (over?: Parameters<typeof fakeDevice>[0]) => {
  const f = fakeDevice(over);
  return { ...f, tools: deviceTools({ device: f.device, screenshotDelayMs: 0 }) };
};

describe("coordinates", () => {
  it("round-trips a model coordinate back to screen space through the addon", async () => {
    const { tools, actions, converted } = build();
    await byName(tools, "screenshot").execute({}, ctx);
    await byName(tools, "click").execute({ x: 200, y: 100 }, ctx);

    expect(converted).toEqual([{ shot: SHOT, point: { space: "shot", x: 200, y: 100 } }]);
    expect(actions[0]).toEqual({ kind: "click", point: { space: "screen", x: 500, y: 250 }, button: "left", count: 1 });
  });

  it("advertises the capped size of the image it hands over", async () => {
    const { tools } = build();
    const r = await byName(tools, "screenshot").execute({}, ctx);
    expect(r.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("1024 by 768") });
    expect(r.content[1]).toEqual({ type: "image", data: "PNGDATA", mime: "image/png" });
  });

  it("refuses to click blind", async () => {
    const { tools, actions } = build();
    await expect(byName(tools, "click").execute({ x: 1, y: 1 }, ctx)).rejects.toThrow(/screenshot first/i);
    expect(actions).toHaveLength(0);
  });

  it("clicks an OCR box where the box actually is, on a retina display", async () => {
    // 2880x1800 at 2x, capped to 1024 wide for the model.
    const retina: ShotGeometry = { originX: 0, originY: 0, scale: 2 * (1024 / 2880), width: 1024, height: 640 };
    const box = { text: "Send", confidence: 1, x: 500, y: 300, width: 40, height: 20 };
    const { tools, actions } = build({
      capture: async () => ({ png: "PNGDATA", shot: retina }),
      recognizeText: async () => [box],
    });

    const read = await byName(tools, "read_screen_text").execute({}, ctx);
    expect(read.content[0]).toMatchObject({ text: expect.stringContaining("Send (500, 300)") });

    await byName(tools, "click").execute({ x: box.x, y: box.y }, ctx);
    expect(actions[0]).toMatchObject({ point: { space: "screen", x: 500 / retina.scale, y: 300 / retina.scale } });
  });

  it("leaves window geometry in the space the window server speaks", async () => {
    const { tools, actions, converted } = build();
    await byName(tools, "screenshot").execute({}, ctx);
    const listed = await byName(tools, "list_windows").execute({}, ctx);
    expect(listed.content[0]).toMatchObject({ text: expect.stringContaining("at (0, 0)") });

    await byName(tools, "window_move").execute({ window_id: 7, x: 0, y: 0 }, ctx);
    expect(actions[0]).toEqual({ kind: "window_move", windowId: 7, point: { space: "screen", x: 0, y: 0 } });
    expect(converted).toHaveLength(0);
  });

  it("converts both ends of a drag", async () => {
    const { tools, actions } = build();
    await byName(tools, "screenshot").execute({}, ctx);
    await byName(tools, "drag").execute({ from_x: 0, from_y: 0, to_x: 100, to_y: 100 }, ctx);
    expect(actions[0]).toEqual({
      kind: "drag",
      path: [{ space: "screen", x: 100, y: 50 }, { space: "screen", x: 300, y: 250 }],
      button: "left",
    });
  });
});

describe("auto-screenshot", () => {
  it("returns the screen the action left behind", async () => {
    const { tools } = build();
    await byName(tools, "screenshot").execute({}, ctx);
    const r = await byName(tools, "keypress").execute({ keys: ["cmd", "s"] }, ctx);
    expect(r.content.map((c) => c.type)).toEqual(["text", "text", "image"]);
  });

  it("says so honestly when the follow-up capture fails", async () => {
    let first = true;
    const { tools } = build({ capture: async () => { if (first) { first = false; return { png: "PNGDATA", shot: SHOT }; } throw new Error("the display went away"); } });
    await byName(tools, "screenshot").execute({}, ctx);
    const r = await byName(tools, "move").execute({ x: 10, y: 10 }, ctx);
    expect(r.content.some((c) => c.type === "text" && c.text.includes("the display went away"))).toBe(true);
    expect(r.content.some((c) => c.type === "image")).toBe(false);
  });

  it("takes one fresh capture per action, and none for perception", async () => {
    let captures = 0;
    const { tools } = build({ capture: async () => { captures++; return { png: "PNGDATA", shot: SHOT }; } });
    await byName(tools, "screenshot").execute({}, ctx);
    expect(captures).toBe(1);
    await byName(tools, "open_url").execute({ url: "https://example.com" }, ctx);
    expect(captures).toBe(2);
    await byName(tools, "list_windows").execute({}, ctx);
    expect(captures).toBe(2);
  });
});

describe("honest degradation", () => {
  it("names Wayland when there is no capture backend", async () => {
    const { tools } = build({ caps: { capture: false, captureBackend: "", session: "wayland" } });
    await expect(byName(tools, "screenshot").execute({}, ctx)).rejects.toThrow(/Wayland/);
  });

  it("names the missing OCR engine", async () => {
    const { tools } = build({ caps: { ocr: false, ocrEngine: "" } });
    await expect(byName(tools, "read_screen_text").execute({}, ctx)).rejects.toThrow(/OCR engine/);
  });

  it("refuses to type into an elevated window instead of dropping the keys", async () => {
    const { tools, actions } = build({ caps: { elevatedWindowInjection: false } });
    await expect(byName(tools, "type").execute({ text: "hi" }, ctx)).rejects.toThrow(/elevated/);
    expect(actions).toHaveLength(0);
  });

  it("refuses to click when the machine is discarding posted events", async () => {
    const { tools, actions } = build({ caps: { postEvents: false } });
    await byName(tools, "screenshot").execute({}, ctx);
    await expect(byName(tools, "click").execute({ x: 1, y: 1 }, ctx)).rejects.toThrow(/discarding every keystroke and click/);
    expect(actions).toHaveLength(0);
  });

  it("still opens an app without post-event access, because that is not posted input", async () => {
    const { tools, actions } = build({ caps: { postEvents: false } });
    await byName(tools, "open_app").execute({ name: "Notes" }, ctx);
    expect(actions).toHaveLength(1);
  });

  it("reads the window in front on every control call, and caches the rest", async () => {
    let elevatedWindowInjection = true;
    let probes = 0;
    const { tools, actions } = build({
      capabilities: async () => { probes++; return { ...CAPS, elevatedWindowInjection }; },
    });
    await byName(tools, "screenshot").execute({}, ctx);
    await byName(tools, "screenshot").execute({}, ctx);
    expect(probes).toBe(1);

    // The user focuses an elevated window: the clicks would be dropped.
    elevatedWindowInjection = false;
    await expect(byName(tools, "click").execute({ x: 1, y: 1 }, ctx)).rejects.toThrow(/elevated/);
    expect(actions).toHaveLength(0);

    // And they leave it again, well inside the cache window.
    elevatedWindowInjection = true;
    await byName(tools, "click").execute({ x: 1, y: 1 }, ctx);
    expect(actions).toHaveLength(1);
  });

  it("refuses rather than returning a black camera frame", async () => {
    const { tools } = build({ cameraFrame: async () => null });
    await expect(byName(tools, "camera_frame").execute({}, ctx)).rejects.toThrow(/camera/i);
  });
});

describe("perception", () => {
  it("lists windows without inventing a title the system withheld", async () => {
    const { tools } = build();
    const r = await byName(tools, "list_windows").execute({}, ctx);
    expect(r.content[0]).toMatchObject({ text: expect.stringContaining("Mail") });
    expect(r.content[0]).not.toMatchObject({ text: expect.stringContaining('""') });
  });

  it("reads screen text with clickable positions", async () => {
    const { tools } = build();
    const r = await byName(tools, "read_screen_text").execute({}, ctx);
    expect(r.content[0]).toMatchObject({ text: expect.stringContaining("Send (500, 250)") });
  });
});


describe("coordinates the model got wrong", () => {
  it("refuses a point outside the picture rather than clicking past its edge", async () => {
    const { tools, actions } = build();
    await byName(tools, "screenshot").execute({}, ctx);
    // 3840 is the display's real width. The model was shown 1024.
    await expect(byName(tools, "click").execute({ x: 3840, y: 400 }, ctx))
      .rejects.toThrow(/1024 by 768/);
    expect(actions).toEqual([]);
  });

  it("takes a point on the far edge of the picture", async () => {
    const { tools, actions } = build();
    await byName(tools, "screenshot").execute({}, ctx);
    await byName(tools, "click").execute({ x: 1024, y: 768 }, ctx);
    expect(actions).toHaveLength(1);
  });
});

describe("scrolling", () => {
  it("scrolls by notches, whatever size the model asks for", async () => {
    const { tools, actions } = build();
    await byName(tools, "screenshot").execute({}, ctx);
    await byName(tools, "scroll").execute({ x: 10, y: 10, vertical: 1200 }, ctx);
    expect(actions[0]).toMatchObject({ kind: "scroll", vertical: 40, horizontal: 0 });
  });

  it("says so rather than posting a scroll of nothing", async () => {
    const { tools, actions } = build();
    await byName(tools, "screenshot").execute({}, ctx);
    await expect(byName(tools, "scroll").execute({ x: 10, y: 10 }, ctx)).rejects.toThrow(/nothing/i);
    expect(actions).toEqual([]);
  });
});

describe("chords", () => {
  it("presses the arrow key a model asked for by its web name", async () => {
    const { tools, actions } = build();
    await byName(tools, "keypress").execute({ keys: ["Cmd", "ArrowDown"] }, ctx);
    expect(actions[0]).toEqual({ kind: "keypress", keys: ["cmd", "down"] });
  });

  it("keeps a side-suffixed modifier the platform does know", async () => {
    const { tools, actions } = build();
    await byName(tools, "keypress").execute({ keys: ["ctrl_left", "c"] }, ctx);
    expect(actions[0]).toEqual({ kind: "keypress", keys: ["ctrl_left", "c"] });
  });
});

describe("the frame the model is working in", () => {
  it("shows the same window again after an action, not whatever is in front", async () => {
    const targets: unknown[] = [];
    const { tools } = build({ capture: async (t) => { targets.push(t); return { png: "PNGDATA", shot: SHOT }; } });
    await byName(tools, "screenshot").execute({ window_id: 7 }, ctx);
    await byName(tools, "click").execute({ x: 10, y: 10 }, ctx);
    expect(targets).toEqual([{ windowId: 7 }, { windowId: 7 }]);
  });

  it("falls back to the display when that window is gone", async () => {
    const targets: unknown[] = [];
    const { tools } = build({
      capture: async (t) => {
        targets.push(t);
        if (t.windowId !== undefined && targets.length > 1) throw new Error("no such window");
        return { png: "PNGDATA", shot: SHOT };
      },
    });
    await byName(tools, "screenshot").execute({ window_id: 7 }, ctx);
    const r = await byName(tools, "window_close").execute({ window_id: 7 }, ctx);
    expect(targets).toEqual([{ windowId: 7 }, { windowId: 7 }, {}]);
    expect(r.content.at(-1)).toMatchObject({ type: "image" });
  });
});

describe("evidence after an action", () => {
  const textOf = (r: { content: { type: string }[] }) =>
    r.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");

  it("names the window in front, because a screenshot alone cannot say a page never navigated", async () => {
    const { tools } = build({
      foreground: async () => ({ id: 7, appName: "Brave Browser", title: "Namecheap", pid: 3, x: 0, y: 0, width: 800, height: 600, minimized: false }),
    });
    await byName(tools, "screenshot").execute({}, ctx);
    const r = await byName(tools, "keypress").execute({ keys: ["enter"] }, ctx);
    expect(textOf(r)).toContain('In front now: Brave Browser — "Namecheap"');
  });

  it("photographs the display once the window it was watching is no longer in front", async () => {
    const targets: Array<{ windowId?: number }> = [];
    const { tools } = build({
      capture: async (t) => { targets.push(t); return { png: "PNGDATA", shot: SHOT }; },
      foreground: async () => ({ id: 9, appName: "Brave Browser", pid: 4, x: 0, y: 0, width: 800, height: 600, minimized: false }),
    });
    await byName(tools, "screenshot").execute({ window_id: 7 }, ctx);
    await byName(tools, "click").execute({ x: 10, y: 10 }, ctx);
    expect(targets).toEqual([{ displayId: undefined, windowId: 7 }, {}]);
  });

  it("waits and looks again, for a page that was still loading", async () => {
    const slept: number[] = [];
    const f = fakeDevice();
    const tools = deviceTools({ device: f.device, sleep: async (ms) => { slept.push(ms); } });
    const r = await byName(tools, "wait").execute({ seconds: 2 }, ctx);
    expect(slept).toEqual([2000]);
    expect(r.content[1]).toEqual({ type: "image", data: "PNGDATA", mime: "image/png" });
  });

  it("gives a launched app longer to appear than a pointer move takes", async () => {
    const slept: number[] = [];
    const f = fakeDevice();
    const tools = deviceTools({ device: f.device, sleep: async (ms) => { slept.push(ms); } });
    await byName(tools, "screenshot").execute({}, ctx);
    await byName(tools, "open_url").execute({ url: "https://youtube.com" }, ctx);
    await byName(tools, "move").execute({ x: 1, y: 1 }, ctx);
    expect(slept[0]).toBeGreaterThan(slept[1]!);
  });
});
