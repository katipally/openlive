import type { DevicePort } from "../capabilities/device.js";
import { inputLock, type InputLock } from "../capabilities/input-lock.js";
import type { ImagePart, TextPart, Tool, ToolResult } from "../capabilities/types.js";
import type { ActionResult, AppInfo, ComputerPort, Snapshot, WindowInfo } from "./helper.js";

// Computer use through the helper: the accessibility tree first, the picture
// second, and actions on numbered elements before pixels. Where the helper
// runs, these replace ol-input's pointer, keyboard and screenshot tools, so a
// session sees one click, one coordinate space and one way to look.
//
// Prompt guidance adapted from Orca's computer-use skill guide (MIT,
// Copyright (c) 2026 Lovecast Inc.; see THIRD_PARTY_NOTICES).

/** ol-input tools these replace. A session with the helper does not get them. */
export const SUPERSEDED: ReadonlySet<string> = new Set([
  "screenshot", "read_screen_text", "wait", "list_windows",
  "click", "double_click", "right_click", "move", "drag", "scroll", "type", "keypress", "mouse_down", "mouse_up",
]);

/** How long the screen gets before the state after an action is read. */
const SETTLE_MS = { commit: 700, typing: 150, default: 250 } as const;
const MAX_WAIT_SECONDS = 10;

const text = (t: string): TextPart => ({ type: "text", text: t });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

const TARGET = {
  app: { type: "string", description: "The app: its name or its id from list_apps (a bundle id on a Mac, an executable on Windows and Linux). Omit to keep using the last app, or the app in front at the start." },
  window_id: { type: "integer", description: "One of the app's windows, from list_windows. Omit for its focused window." },
};
const ELEMENT = { type: "integer", description: "An element number from the latest state of this window" };
const PIXEL = (axis: string) => ({ type: "integer", description: `${axis} in the latest picture of this window, only when no element fits` });
const BUTTON = { button: { type: "string", enum: ["left", "right", "middle"], description: "Defaults to left" } };

export interface ComputerToolOpts {
  computer: ComputerPort;
  /** ol-input, for OCR over the helper's picture. */
  device: DevicePort;
  lock?: InputLock;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

const keyList = (a: { keys?: unknown }) => (Array.isArray(a.keys) ? a.keys : [a.keys]).map((k) => String(k ?? "").trim()).filter(Boolean);

const describeWindow = (w: WindowInfo) =>
  `${w.id}: ${w.appName}${w.title ? ` "${w.title}"` : ""} at (${Math.round(w.x)}, ${Math.round(w.y)}) ${Math.round(w.width)} by ${Math.round(w.height)}${w.onScreen ? "" : ", off screen"}`;

/** How the model should weigh an action's outcome. Never "done" unless it was read back. */
function outcome(r: ActionResult): string {
  const a = r.action;
  if (a.verified) return `Done (${a.actionName}), and read back.`;
  const how = a.path === "accessibility"
    ? `The element's own action ran (${a.actionName}); nothing read it back.`
    : `Input was posted (${a.actionName}); nothing confirms it landed.`;
  return `${how} The state below is the only evidence: if it does not show the change, the step did not work.`;
}

export function computerTools(opts: ComputerToolOpts): Tool[] {
  const { computer, device } = opts;
  const lock = opts.lock ?? inputLock;
  const sleep = opts.sleep ?? wait;
  /** The window this session is working in: every call without an app goes back to it. */
  let target: { app?: string; window_id?: number } = {};
  let lastShot: Snapshot["screenshot"] | null = null;

  /** A named app starts afresh; otherwise the session's window carries over. */
  const params = (a: { app?: string; window_id?: number }) => {
    const app = a.app ?? target.app;
    const windowId = a.window_id ?? (a.app === undefined ? target.window_id : undefined);
    return { ...(app && { app }), ...(windowId !== undefined && { windowId }) };
  };

  /** Remember where the model is working, and say what it is looking at. */
  const state = (s: Snapshot, lead: string): ToolResult<{ snapshot: Omit<Snapshot, "screenshot"> }> => {
    target = { app: s.app.bundleId ?? `pid:${s.app.pid}`, window_id: s.window.id };
    lastShot = s.screenshot ?? null;
    const picture = s.screenshot
      ? `The picture is ${s.screenshot.width} by ${s.screenshot.height}; x and y are in that picture.`
      : `No picture: ${s.screenshotError ?? "not asked for"}.`;
    const content: (TextPart | ImagePart)[] = [text([lead, `${s.app.name}, window ${s.window.id}. ${picture}`, "", s.treeText].join("\n"))];
    if (s.screenshot) content.push({ type: "image", data: s.screenshot.data, mime: s.screenshot.mime });
    const { screenshot: _, ...rest } = s;
    return { content, details: { snapshot: rest } };
  };

  const look = async (a: { app?: string; window_id?: number; screenshot?: boolean }, lead: string) =>
    state(await computer.call<Snapshot>("getAppState", { ...params(a), screenshot: a.screenshot ?? true }), lead);

  /** One action under the machine's input lock, answered with the window it left behind. */
  const act = (method: string | ((a: any) => string), build: (a: any) => Record<string, unknown>, settleMs: number) =>
    async (a: any, ctx: { signal: AbortSignal }) => {
      const name = typeof method === "string" ? method : method(a);
      const r = await lock.run(() => computer.call<ActionResult>(name, { ...params(a), ...build(a), settleMs }), ctx.signal);
      if (r.state) return state(r.state, outcome(r));
      return { content: [text(`${outcome(r)} The window could not be read afterwards: ${r.stateError ?? "no reason given"}.`)], details: { action: r.action } };
    };

  const where = (a: { app?: string }) => a.app ?? target.app ?? "the app in front";
  const at = (a: Record<string, unknown>) => (a.element !== undefined ? { elementIndex: a.element } : { x: a.x, y: a.y });

  return [
    {
      name: "list_apps",
      readOnly: true,
      description: "The apps running on this machine, with their ids (bundle ids on a Mac, executables on Windows and Linux), the one in front first.",
      parameters: obj({}),
      async execute() {
        const { apps } = await computer.call<{ apps: AppInfo[] }>("listApps");
        return { content: [text(apps.map((a) => `${a.name}${a.bundleId ? ` (${a.bundleId})` : ""}${a.active ? ", in front" : ""}`).join("\n") || "No apps are running.")], details: { apps } };
      },
    },
    {
      name: "list_windows",
      readOnly: true,
      description: "Open windows, of one app or of all, with ids and desktop positions. The ids work with get_app_state and with the window_ tools; the positions are desktop coordinates, never a place to click.",
      parameters: obj({ app: TARGET.app }),
      async execute(a: { app?: string }) {
        const { windows } = await computer.call<{ windows: WindowInfo[] }>("listWindows", a.app ? { app: a.app } : {});
        return { content: [text(windows.map(describeWindow).join("\n") || "No windows are open.")], details: { windows } };
      },
    },
    {
      name: "get_app_state",
      readOnly: true,
      description: "Look at one app window: its accessibility tree, every element numbered, then a picture of it. Start here, and act on the numbers.",
      parameters: obj({ ...TARGET, screenshot: { type: "boolean", description: "Include the picture. Defaults to true; the tree alone is faster." } }),
      promptGuidelines: [
        "To work in an app, call get_app_state first and act on its numbered elements. Every action answers with the window's new state: read it before the next step. Element numbers go stale after any change, so only ever use numbers from the latest state.",
        "Prefer the meaning over the pixels: set_value for a field, click with an element number, perform_action with an action the element lists. Use x and y from the picture only when no element fits.",
        "An action's result says how sure it is. \"Read back\" means it was checked. Anything else is unproven until the state shows it, so never tell the user something was sent, saved, bought or deleted unless the state shows it.",
        "Name the app by its name or its id from list_apps. Without one you get the window in front that is not OpenLive's own.",
        "Do not send, submit, buy, delete, or change account settings unless the user asked for exactly that. Password managers are off limits.",
        "In a browser, set the address field with set_value, then keypress Return.",
      ],
      execute: (a: { app?: string; window_id?: number; screenshot?: boolean }) => look(a, "The window now."),
    },
    {
      name: "wait",
      readOnly: true,
      description: "Let the app catch up, then look again. For a page still loading or an app still starting.",
      parameters: obj({ ...TARGET, seconds: { type: "number", description: "How long, up to 10. Defaults to 1." } }),
      async execute(a: { app?: string; window_id?: number; seconds?: number }) {
        const seconds = Math.min(Math.max(Number(a.seconds) || 1, 0.1), MAX_WAIT_SECONDS);
        await sleep(seconds * 1000);
        return look(a, `Waited ${seconds === 1 ? "a second" : `${seconds} seconds`}.`);
      },
    },
    {
      name: "read_screen_text",
      readOnly: true,
      description: "Read the text in a window's picture with OCR, with where each piece sits in that picture. For text the tree does not carry, such as a canvas or an image. Those positions are what click takes as x and y.",
      parameters: obj(TARGET),
      async execute(a: { app?: string; window_id?: number }) {
        await look(a, "");
        const shot = lastShot;
        if (!shot) throw new Error("There is no picture of this window to read, so there is nothing for OCR.");
        const boxes = await device.recognizeText(shot.data, { originX: 0, originY: 0, scale: 1, width: shot.width, height: shot.height });
        if (!boxes.length) return { content: [text("No text was recognised in the window.")], details: { boxes } };
        const lines = boxes.map((b) => `${b.text} (${Math.round(b.x)}, ${Math.round(b.y)})`).join("\n");
        return { content: [text(`Text in the ${shot.width} by ${shot.height} picture of the window:\n${lines}`)], details: { boxes } };
      },
    },
    {
      name: "click",
      description: "Click an element by its number, or a point in the latest picture. Presses it through accessibility when it can, which works even when the window is behind another.",
      parameters: obj({
        element: ELEMENT, x: PIXEL("Horizontal position"), y: PIXEL("Vertical position"),
        button: { type: "string", enum: ["left", "right", "middle"], description: "Defaults to left; right opens the context menu" },
        count: { type: "integer", description: "2 for a double click. Defaults to 1" },
        ...TARGET,
      }),
      confirm: (a) => `click in ${where(a)}`,
      execute: act("click", (a) => ({ ...at(a), ...(a.button && { button: a.button }), ...(a.count && { count: a.count }) }), SETTLE_MS.commit),
    },
    {
      name: "perform_action",
      description: "Run one of the secondary actions an element lists in the state (\"Secondary Actions: ...\"), by that name.",
      parameters: obj({ element: ELEMENT, action: { type: "string", description: "One of the element's listed actions" }, ...TARGET }, ["element", "action"]),
      confirm: (a) => `${a.action} in ${where(a)}`,
      execute: act("performSecondaryAction", (a) => ({ elementIndex: a.element, action: a.action }), SETTLE_MS.commit),
    },
    {
      name: "set_value",
      description: "Set a field's whole value directly: a text field, a search box, a slider, a checkbox. Replaces what is there. The surest way to fill a field.",
      parameters: obj({ element: ELEMENT, value: { type: "string" }, ...TARGET }, ["element", "value"]),
      confirm: (a) => `fill in a field in ${where(a)}`,
      execute: act("setValue", (a) => ({ elementIndex: a.element, value: a.value }), SETTLE_MS.typing),
    },
    {
      name: "type",
      description: "Type text into whatever has focus in the app, after clicking into the field. For a field you can name, set_value is surer. For putting the user's own words in their document, use insert_text instead.",
      parameters: obj({ text: { type: "string" }, paste: { type: "boolean", description: "Paste it through the clipboard instead, for long text. The user's clipboard is put back after." }, ...TARGET }, ["text"]),
      confirm: (a) => `type ${String(a.text).length} characters in ${where(a)}`,
      execute: act((a) => (a.paste ? "pasteText" : "typeText"), (a) => ({ text: a.text }), SETTLE_MS.typing),
    },
    {
      name: "keypress",
      description: "Press a key or a shortcut in the app, as [\"Return\"] or [\"cmdorctrl\", \"shift\", \"p\"]; cmdorctrl is cmd on a Mac and ctrl elsewhere, and cmd elsewhere is the Windows or Super key. Enter usually commits something, so read the state that comes back.",
      parameters: obj({ keys: { type: "array", items: { type: "string" }, description: "The keys held together; the last one is the key" }, ...TARGET }, ["keys"]),
      confirm: (a) => `press ${keyList(a).join("+")} in ${where(a)}`,
      execute: act((a) => (keyList(a).length > 1 ? "hotkey" : "pressKey"), (a) => {
        const keys = keyList(a);
        if (!keys.length) throw new Error("A keypress needs at least one key.");
        return { key: keys.join("+") };
      }, SETTLE_MS.commit),
    },
    {
      name: "scroll",
      description: "Scroll an element (by its number) or the point under x and y, by pages.",
      parameters: obj({
        element: ELEMENT, x: PIXEL("Horizontal position"), y: PIXEL("Vertical position"),
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        pages: { type: "number", description: "How far, in pages. Defaults to 1" },
        ...TARGET,
      }, ["direction"]),
      confirm: (a) => `scroll in ${where(a)}`,
      execute: act("scroll", (a) => ({ ...at(a), direction: a.direction, ...(a.pages && { pages: a.pages }) }), SETTLE_MS.default),
    },
    {
      name: "move",
      description: "Move the pointer onto an element or a point without pressing anything, to reveal a hover state such as a tooltip or a menu that opens on hover.",
      parameters: obj({ element: ELEMENT, x: PIXEL("Horizontal position"), y: PIXEL("Vertical position"), ...TARGET }),
      execute: act("move", at, SETTLE_MS.default),
    },
    {
      name: "mouse_down",
      description: "Press and hold a mouse button on an element or a point. Pair it with mouse_up, after any moves, for a gesture click and drag cannot express.",
      parameters: obj({ element: ELEMENT, x: PIXEL("Horizontal position"), y: PIXEL("Vertical position"), ...BUTTON, ...TARGET }),
      confirm: (a) => `press the mouse in ${where(a)}`,
      execute: act("mouseDown", (a) => ({ ...at(a), ...(a.button && { button: a.button }) }), SETTLE_MS.default),
    },
    {
      name: "mouse_up",
      description: "Release the mouse button mouse_down is holding, on an element or a point.",
      parameters: obj({ element: ELEMENT, x: PIXEL("Horizontal position"), y: PIXEL("Vertical position"), ...BUTTON, ...TARGET }),
      confirm: (a) => `release the mouse in ${where(a)}`,
      execute: act("mouseUp", (a) => ({ ...at(a), ...(a.button && { button: a.button }) }), SETTLE_MS.commit),
    },
    {
      name: "drag",
      description: "Drag from one element or point to another: a slider thumb, a file onto a folder, a selection.",
      parameters: obj({
        from_element: ELEMENT, to_element: ELEMENT,
        from_x: PIXEL("Start x"), from_y: PIXEL("Start y"), to_x: PIXEL("End x"), to_y: PIXEL("End y"),
        ...TARGET,
      }),
      confirm: (a) => `drag in ${where(a)}`,
      execute: act("drag", (a) => ({
        ...(a.from_element !== undefined ? { fromElementIndex: a.from_element } : { fromX: a.from_x, fromY: a.from_y }),
        ...(a.to_element !== undefined ? { toElementIndex: a.to_element } : { toX: a.to_x, toY: a.to_y }),
      }), SETTLE_MS.default),
    },
  ];
}
