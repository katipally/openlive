import { describe, expect, it } from "vitest";
import { registry, ToolRegistry, type ToolProvider } from "./registry.js";
import { CHAT, FLOW } from "./profiles.js";
import type { DevicePort } from "./device.js";
import type { ComputerPort } from "../computer/helper.js";
import type { Session, Tool } from "./types.js";

const device = {} as DevicePort;
const clipboard = { read: async () => "", write: async () => {} };
const insert = { commit: async () => {}, end: async () => {}, abandon: async () => {}, committed: () => "" };
const call: Session = { clipboard, openUrl: async () => "", share: { showing: () => null, frame: async () => null }, workspace: () => "", emit: () => {} };
const flow: Session = { foreground: { capture: async () => null }, insert, clipboard, device };
const names = (profile: typeof CHAT | typeof FLOW, s: Session) => registry.tools(profile, s).list.map((t) => t.name);

const DEVICE = [
  "screenshot", "read_screen_text", "wait", "list_windows", "get_window", "camera_frame",
  "click", "double_click", "right_click", "move", "drag", "scroll", "type", "keypress", "mouse_down", "mouse_up",
  "window_activate", "window_move", "window_resize", "window_minimize", "window_close", "open_app", "open_url", "shell",
];

/** OpenLive's own tools every session gets: timers and reminders, saving a skill and setting connectors up. */
const REMINDERS = ["set_timer", "remind", "list_reminders", "cancel_reminder"];
const SETUP = ["save_skill", "list_connectors", "add_connector", "connector_sign_in", "reconnect_connector"];

describe("the registry", () => {
  it("gives Flow its text tools first, then the machine, then OpenLive's own", () => {
    expect(names(FLOW, flow)).toEqual([
      "insert_text", "read_selection", "clipboard_read", "clipboard_write", "get_context",
      ...DEVICE, "delegate", "update_todos", "remember", ...REMINDERS, ...SETUP,
    ]);
  });

  it("gives a call its own order, and the machine after it on the desktop", () => {
    expect(names(CHAT, call)).toEqual([...CHAT.order, ...REMINDERS, ...SETUP]);
    const desktop = names(CHAT, { ...call, device });
    expect(desktop.slice(0, CHAT.order.length)).toEqual([...CHAT.order]);
    expect(desktop.slice(CHAT.order.length).sort()).toEqual([...DEVICE.filter((n) => n !== "open_url"), ...REMINDERS, ...SETUP].sort());
  });

  it("has one open_url: the device's where there is one, the client's otherwise", async () => {
    const web = registry.tools(CHAT, call).resolve("open_url")!;
    const desktop = registry.tools(CHAT, { ...call, device }).resolve("open_url")!;
    expect(web).not.toBe(desktop);
    expect(web.description).toBe(desktop.description);
    expect(web.parameters).toEqual(desktop.parameters);
    expect(names(CHAT, { ...call, device }).filter((n) => n === "open_url")).toHaveLength(1);
  });

  it("builds the device tools afresh for each session, since they remember its last screenshot", () => {
    const a = registry.tools(FLOW, flow).resolve("click");
    const b = registry.tools(FLOW, flow).resolve("click");
    expect(a).not.toBe(b);
  });

  it("offers nothing a session cannot reach", () => {
    expect(names(CHAT, {})).toEqual(["delegate", "update_todos", "remember", ...REMINDERS, ...SETUP]);
  });
});

describe("the machine's tools with the computer-use helper", () => {
  const computer = { call: async () => ({}) } as ComputerPort;
  const HELPER = ["list_apps", "list_windows", "get_app_state", "wait", "read_screen_text", "click", "perform_action", "set_value", "type", "keypress", "scroll", "drag", "move", "mouse_down", "mouse_up"];
  const KEPT = ["get_window", "camera_frame", "window_activate", "window_move", "window_resize", "window_minimize", "window_close", "open_app", "open_url", "shell"];

  it("offers one coherent surface: the helper's tools, plus what only ol-input does", () => {
    const flowNames = names(FLOW, { ...flow, computer });
    expect(new Set(flowNames).size).toBe(flowNames.length);
    expect(flowNames.slice(5, 5 + HELPER.length + KEPT.length).sort()).toEqual([...HELPER, ...KEPT].sort());
    for (const gone of ["screenshot", "double_click", "right_click"]) expect(flowNames).not.toContain(gone);
    expect(flowNames.slice(0, 5)).toEqual(["insert_text", "read_selection", "clipboard_read", "clipboard_write", "get_context"]);
  });

  it("serves the helper's click, not ol-input's", () => {
    const click = registry.tools(FLOW, { ...flow, computer }).resolve("click")!;
    expect(click.parameters).toMatchObject({ properties: { element: { type: "integer" } } });
  });

  it("falls back to ol-input's tools where there is no helper", () => {
    expect(names(FLOW, flow)).toContain("screenshot");
    expect(names(FLOW, flow)).not.toContain("get_app_state");
  });

  it("needs the device too: a session off the desktop gets neither", () => {
    expect(names(CHAT, { ...call, computer })).not.toContain("get_app_state");
  });
});

describe("a provider", () => {
  const tool = (name: string, over: Partial<Tool> = {}): Tool => ({ name, description: "", parameters: { type: "object", properties: {} }, async execute() { return { content: [], details: null }; }, ...over });

  it("adds tools to every session it applies to, and can be taken away", () => {
    const r = new ToolRegistry();
    const provider: ToolProvider = (s) => (s.workspace ? [tool("connector_search")] : []);
    const off = r.register(provider);
    expect(r.tools(CHAT, call).list.map((t) => t.name)).toEqual(["connector_search"]);
    expect(r.tools(FLOW, flow).list).toEqual([]);
    off();
    expect(r.tools(CHAT, call).list).toEqual([]);
  });

  it("never shadows a tool already registered under that name", () => {
    const r = new ToolRegistry();
    const first = tool("remember");
    r.register(() => [first]);
    r.register(() => [tool("remember"), tool("activate_skill")]);
    const set = r.tools(FLOW, flow);
    expect(set.resolve("remember")).toBe(first);
    expect(set.list.map((t) => t.name)).toEqual(["remember", "activate_skill"]);
  });

  it("has its tools filtered by what they say they need", () => {
    const r = new ToolRegistry();
    r.register(() => [tool("needs_device", { available: (s) => !!s.device }), tool("anywhere")]);
    expect(r.tools(CHAT, call).list.map((t) => t.name)).toEqual(["anywhere"]);
    expect(r.tools(FLOW, flow).list.map((t) => t.name)).toEqual(["needs_device", "anywhere"]);
  });
});

describe("approval per mode", () => {
  const confirming = names(CHAT, { ...call, device }).filter((n) => registry.tools(CHAT, { ...call, device }).resolve(n)!.confirm);

  it("asks in a call before an action changes something on the machine or in the workspace", () => {
    expect(confirming.sort()).toEqual([
      "add_connector", "click", "double_click", "drag", "edit_file", "keypress", "mouse_down", "mouse_up", "open_app", "right_click",
      "save_skill", "scroll", "shell", "type", "window_activate", "window_close", "window_minimize", "window_move", "window_resize", "write_file",
    ]);
  });

  it("never asks before a read", () => {
    const set = registry.tools(CHAT, { ...call, device });
    for (const t of set.list) if (t.readOnly) expect(t.confirm, t.name).toBeUndefined();
  });

  it("asks Flow once for everything, through consent", async () => {
    let granted = false, asked = 0;
    const approve = FLOW.approval({ granted: () => granted, ask: async () => { asked++; return true; }, remember: async () => { granted = true; } });
    for (const t of registry.tools(FLOW, flow).list) expect(await approve({ tool: t, args: {} }, new AbortController().signal)).toEqual({});
    expect(asked).toBe(1);
  });
});
