import { describe, expect, it } from "vitest";
import { deviceTools } from "./device-tools.js";
import type { CapabilityReport, ControlAction, DevicePort, ShotGeometry, ShotPoint } from "./device.js";
import type { Tool, ToolCtx } from "./types.js";

const CAPS: CapabilityReport = {
  hook: true, injection: "paste", capture: true, captureBackend: "screencapturekit",
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

describe("risk tiers", () => {
  it("puts perception on read, control on control and the shell on destructive", () => {
    const { tools } = build();
    const tier = (n: string) => byName(tools, n).tier;
    expect([tier("screenshot"), tier("read_screen_text"), tier("list_windows"), tier("get_window"), tier("camera_frame")])
      .toEqual(["read", "read", "read", "read", "read"]);
    expect([tier("click"), tier("type"), tier("window_close"), tier("open_url")])
      .toEqual(["control", "control", "control", "control"]);
    expect(tier("shell")).toBe("destructive");
    expect(byName(tools, "shell").risk).toBe("dangerous");
    expect(byName(tools, "screenshot").risk).toBe("safe");
    expect(byName(tools, "click").risk).toBe("confirm");
  });
});
