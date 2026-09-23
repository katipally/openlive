import type {
  CapabilityReport, ControlAction, DevicePort, MouseButton, ScreenPoint, ShotGeometry, WindowSummary,
} from "./device.js";
import { screenPoint, shotPoint } from "./device.js";
import type { ImagePart, TextPart, Tool, ToolResult } from "./types.js";

// Perception and control, as one flat action set over the device seam.
//
// Three rules hold the whole file together. Every coordinate the model is shown
// or sends for pointing at the screen is in the image it was shown, OCR boxes
// included, and only `shotToScreen` turns one into something a control call may
// touch. Window geometry is the one exception and is declared as such: it is
// desktop coordinates in and out, straight from the window server and straight
// back to it, because a window's size in screenshot pixels would mean nothing to
// the platform that has to apply it. And every action that changes the screen
// returns the new screen, so the brain never has to ask for a screenshot it was
// always going to need.

const text = (t: string): TextPart => ({ type: "text", text: t });
const image = (data: string): ImagePart => ({ type: "image", data, mime: "image/png" });

/**
 * Settle time before the automatic screenshot, per action.
 *
 * One constant cannot serve both: a menu paints in a frame, and a page loads in
 * a second. The screenshot is the model's only evidence that the action worked,
 * so photographing too early is not a cosmetic problem — it is how the model
 * comes to believe a page it never reached is already open, and says so.
 */
const DEFAULT_SCREENSHOT_DELAY_MS = 150;
/** Launching an app or a URL: the window does not exist yet when the call returns. */
const LAUNCH_SETTLE_MS = 1_500;
/** A click or a keystroke that commonly navigates: enough for a page to begin painting. */
const COMMIT_SETTLE_MS = 700;
/** How long the machine-wide half of a capability report stays true. */
const CAPABILITY_TTL_MS = 30_000;
const SHELL_OUTPUT_CAP = 4_000;
/** Longer than this and the user is listening to silence, which is what the reply is for. */
const MAX_WAIT_SECONDS = 10;

export interface DeviceToolOpts {
  device: DevicePort;
  /** One settle time for every action, overriding the per-action ones. Tests pass 0. */
  screenshotDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

// ── capability degradation ──────────────────────────────────────────────────

/** Named, specific, and thrown so the loop turns it into a tool result the model reads. */
function refuse(what: string, why: string): never {
  throw new Error(`${what} is unavailable on this machine: ${why}`);
}

function requireCapture(caps: CapabilityReport): void {
  if (caps.capture) return;
  refuse("Screen capture", caps.session === "wayland"
    ? "this is a Wayland session and no portal or compositor capture tool was found."
    : `no capture backend (${caps.captureBackend || "none"}).`);
}

/** The actions that reach other apps as posted keyboard and mouse events.
 *  Opening an app, a URL or a window goes through the window server instead,
 *  and refusing those for want of a post-event grant would be its own lie. */
const POSTED_INPUT = new Set<ControlAction["kind"]>([
  "move", "click", "mouse_down", "mouse_up", "drag", "scroll", "type", "keypress",
]);

function requireControl(caps: CapabilityReport, posted: boolean): void {
  if (!caps.elevatedWindowInjection) {
    refuse("Input", "the window in front is running elevated, so synthetic input would be dropped without any sign of it. Ask the user to click there themselves.");
  }
  if (posted && caps.postEvents === false) {
    refuse("Input", "this machine is discarding every keystroke and click OpenLive sends, so the action would do nothing at all. The user has to grant OpenLive permission to control the computer, and restart it, before clicking and typing work.");
  }
}

// ── the tool set ────────────────────────────────────────────────────────────

export function deviceTools(opts: DeviceToolOpts): Tool[] {
  const { device } = opts;
  const settleFor = (spec: ControlSpec) => opts.screenshotDelayMs ?? spec.settleMs ?? DEFAULT_SCREENSHOT_DELAY_MS;
  const sleep = opts.sleep ?? wait;

  // The geometry of the last image the model was shown. Every coordinate it
  // sends back is in this image's space until it is shown another one.
  let lastShot: ShotGeometry | null = null;
  /** What that image was of. The screenshot after an action repeats it, so the
   *  space the model's coordinates are in only ever changes when the model
   *  itself asks for a different picture. */
  let lastTarget: { displayId?: number; windowId?: number } = {};
  let caps: { at: number; report: CapabilityReport } | null = null;

  /** `elevatedWindowInjection` is a fact about the window in FRONT, which the
   *  user can change between two sentences, so a control call reads it now. */
  const freshCapabilities = async (): Promise<CapabilityReport> => {
    const report = await device.capabilities();
    caps = { at: Date.now(), report };
    return report;
  };

  const capabilities = async (): Promise<CapabilityReport> =>
    (caps && Date.now() - caps.at < CAPABILITY_TTL_MS ? caps.report : freshCapabilities());

  const capture = async (target: { displayId?: number; windowId?: number }) => {
    requireCapture(await capabilities());
    const shot = await device.capture(target);
    lastShot = shot.shot;
    lastTarget = target;
    return shot;
  };

  /**
   * The model's coordinate, converted by the addon. Nothing here does the
   * arithmetic.
   *
   * A point outside the image is refused rather than converted. It is the
   * common failure when a model answers in the display's real resolution
   * instead of the capped image it was shown, and converting it would put the
   * pointer somewhere off the picture and click whatever was there.
   */
  const toScreen = async (x: number, y: number): Promise<ScreenPoint> => {
    if (!lastShot) throw new Error("I do not know what the screen looks like yet. Take a screenshot first, then use the coordinates from it.");
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`(${x}, ${y}) is not a position on the screen.`);
    if (x < 0 || y < 0 || x > lastShot.width || y > lastShot.height) {
      throw new Error(`(${Math.round(x)}, ${Math.round(y)}) is outside the picture you were given, which is ${lastShot.width} by ${lastShot.height}. Use the coordinates of that image, not of the display behind it.`);
    }
    return device.shotToScreen(lastShot, shotPoint(x, y));
  };

  const screenshotResult = (png: string, shot: ShotGeometry, lead: string): ToolResult<{ shot: ShotGeometry }> => ({
    content: [text(`${lead} The image is ${shot.width} by ${shot.height}; give coordinates in that space.`), image(png)],
    details: { shot },
  });

  /**
   * Every action that changes the screen answers with the screen it left
   * behind, so the brain never has to ask for a picture it was always going to
   * need. An action that ended the turn is not followed by anything, so it does
   * not get one.
   */
  const withAutoScreenshot = (tool: Tool, settleMs: number): Tool => ({
    ...tool,
    async execute(args, ctx) {
      const r = await tool.execute(args, ctx);
      if (r.terminate) return r;
      await sleep(settleMs);
      // Which window is in front is the cheapest true statement about what the
      // action did, and the one a picture is easiest to be wrong about: a
      // screenshot of the old window looks exactly like a page that never
      // navigated.
      const front = await device.foreground().catch(() => null);
      const here = front ? `In front now: ${front.appName}${front.title ? ` — "${front.title}"` : ""}.` : "";
      try {
        // Keep photographing the same window only while it is still the window
        // in front. Anything else — it closed, or the action put something else
        // on top — is better answered by the display.
        const stay = lastTarget.windowId !== undefined && front?.id === lastTarget.windowId;
        const { png, shot } = await capture(stay ? lastTarget : {}).catch(() => capture({}));
        return { ...r, content: [...r.content, text([here, `The screen now, ${shot.width} by ${shot.height}. This is the evidence: if it does not show what you expected, the step did not work.`].filter(Boolean).join(" ")), image(png)] };
      } catch (e) {
        // The action itself worked. Saying so without a picture beats failing it.
        return { ...r, content: [...r.content, text([here, `I cannot show you the result: ${msg(e)}`].filter(Boolean).join(" "))] };
      }
    },
  });

  const perception: Tool[] = [
    {
      name: "screenshot",
      description: "Look at the screen. Returns a picture of a display, or of one window, with the size you must use for coordinates.",
      parameters: obj({ display_id: { type: "integer", description: "Which display. Omit for the one in front." }, window_id: { type: "integer", description: "Capture just this window instead." } }, []),
      promptGuidelines: [
        "Take a screenshot before clicking anything, and use the coordinates of the image you were given: everything you point at, including the positions read_screen_text gives you, is in that image's space.",
        "A page or an app that was still loading when you looked is worth one wait and another look, never a guess about what it probably says by now.",
        "Window positions and sizes are the one exception. They are desktop coordinates, they only ever go back to the window tools, and they are never a place to click.",
      ],
      async execute(args: { display_id?: number; window_id?: number }) {
        const { png, shot } = await capture({ displayId: args.display_id, windowId: args.window_id });
        return screenshotResult(png, shot, "Here is the screen.");
      },
    },
    {
      name: "read_screen_text",
      description: "Read the text on screen with OCR, with where each piece of text sits in the screenshot it was read from. Those coordinates are the ones click takes.",
      parameters: obj({ display_id: { type: "integer" }, window_id: { type: "integer" } }, []),
      async execute(args: { display_id?: number; window_id?: number }) {
        const report = await capabilities();
        if (!report.ocr) refuse("Text recognition", `no OCR engine is available (${report.ocrEngine || "none"}).`);
        const { png, shot } = await capture({ displayId: args.display_id, windowId: args.window_id });
        const boxes = await device.recognizeText(png, shot);
        if (!boxes.length) return { content: [text("No text was recognised on screen.")], details: { boxes } };
        const lines = boxes.map((b) => `${b.text} (${Math.round(b.x)}, ${Math.round(b.y)})`).join("\n");
        return { content: [text(`Text on screen, positioned in the ${shot.width} by ${shot.height} screenshot it was read from:\n${lines}`)], details: { boxes } };
      },
    },
    {
      name: "wait",
      description: "Let the screen catch up, then look again. For a page still loading, an app still starting, or anything that was not finished when you last looked.",
      parameters: obj({ seconds: { type: "number", description: "How long to wait, up to 10. Defaults to 1." } }, []),
      async execute(args: { seconds?: number }) {
        const seconds = Math.min(Math.max(Number(args.seconds) || 1, 0.1), MAX_WAIT_SECONDS);
        await sleep(seconds * 1000);
        const { png, shot } = await capture(lastTarget).catch(() => capture({}));
        return screenshotResult(png, shot, `Waited ${seconds === 1 ? "a second" : `${seconds} seconds`}.`);
      },
    },
    {
      name: "list_windows",
      description: "Every open window: the app, the window title when the system will say it, and its position and size in desktop coordinates. Those are not screenshot coordinates: to click something in a window, take a screenshot.",
      parameters: obj({}, []),
      async execute() {
        const windows = await device.windows();
        if (!windows.length) return { content: [text("No windows are open.")], details: { windows } };
        return { content: [text(windows.map(describeWindow).join("\n"))], details: { windows } };
      },
    },
    {
      name: "get_window",
      description: "Details of one window, or of the window in front when you do not name one. Its position and size are desktop coordinates, not screenshot coordinates.",
      parameters: obj({ window_id: { type: "integer", description: "Omit for the window in front." } }, []),
      async execute(args: { window_id?: number }) {
        const window = args.window_id === undefined
          ? await device.foreground()
          : (await device.windows()).find((w) => w.id === args.window_id) ?? null;
        if (!window) return { content: [text(args.window_id === undefined ? "I cannot see which window is in front." : `There is no window ${args.window_id}.`)], details: { window: null } };
        return { content: [text(describeWindow(window))], details: { window } };
      },
    },
    {
      name: "camera_frame",
      description: "One frame from the user's camera, for when they ask about something they are holding up or pointing at.",
      parameters: obj({}, []),
      async execute() {
        const frame = await device.cameraFrame();
        if (!frame) refuse("The camera", "it is off or no frame came back.");
        return { content: [text("From the camera:"), { type: "image", data: frame.data, mime: frame.mime }], details: { mime: frame.mime } };
      },
    },
  ];

  const control = CONTROL_ACTIONS.map((spec) => withAutoScreenshot({
    name: spec.name,
    description: spec.description,
    parameters: obj(spec.properties, spec.required),
    async execute(args: Record<string, any>) {
      const action = await spec.build(args, toScreen);
      requireControl(await freshCapabilities(), POSTED_INPUT.has(action.kind));
      await device.control(action);
      const summary = spec.summary(args);
      return { content: [text(summary)], details: { action: summary } };
    },
  }, settleFor(spec)));

  const shell: Tool<{ command: string }, { code: number; stdout: string; stderr: string }> = {
    name: "shell",
    description: "Run a shell command on the user's machine and read its output. Use it for things a command does well, never for clicking around an app.",
    parameters: obj({ command: { type: "string", description: "The command line to run" } }, ["command"]),
    promptGuidelines: ["Nothing stops a shell command once you call it, so say what you are running in the same breath, and do not run one they did not ask for."],
    async execute(args) {
      const r = await device.shell(args.command);
      const out = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join("\n").slice(0, SHELL_OUTPUT_CAP);
      return { content: [text(out || (r.code === 0 ? "Done, with no output." : `Exit code ${r.code}, with no output.`))], details: r };
    },
  };

  return [...perception, ...control, shell];
}

// ── the control table ───────────────────────────────────────────────────────

interface ControlSpec {
  name: string;
  description: string;
  /** How long the screen needs to catch up with this action. Omitted means a frame. */
  settleMs?: number;
  properties: Record<string, unknown>;
  required: string[];
  build(args: any, toScreen: (x: number, y: number) => Promise<ScreenPoint>): Promise<ControlAction>;
  summary(args: any): string;
}

const XY = {
  x: { type: "integer", description: "Horizontal position in the screenshot you were given" },
  y: { type: "integer", description: "Vertical position in the screenshot you were given" },
};
const WINDOW_XY = {
  x: { type: "integer", description: "Horizontal desktop position, as list_windows reports it" },
  y: { type: "integer", description: "Vertical desktop position, as list_windows reports it" },
};
const BUTTON = { button: { type: "string", enum: ["left", "right", "middle"], description: "Defaults to left" } };
const button = (a: { button?: MouseButton }): MouseButton => a.button ?? "left";
/** A wheel distance a machine could plausibly be asked for. Models reach for
 *  pixel counts here, and a few hundred notches is a page that never stops. */
const MAX_NOTCHES = 40;
const notches = (value: unknown): number => {
  const amount = Math.round(Number(value) || 0);
  return Number.isFinite(amount) ? Math.max(-MAX_NOTCHES, Math.min(MAX_NOTCHES, amount)) : 0;
};
const at = (a: { x: number; y: number }) => `(${a.x}, ${a.y})`;

/** The spellings a model reaches for that the platform has never heard of.
 *  Everything else goes through as written and is resolved by name there. */
const KEY_SPELLINGS: Record<string, string> = {
  arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right",
  page_up: "pageup", page_down: "pagedown", pgup: "pageup", pgdn: "pagedown", pgdown: "pagedown",
  spacebar: "space", windows: "win", del: "delete",
};
/** Left alone but for case and stray spaces, because `ctrl_left` and the rest
 *  of the side-suffixed modifiers are spellings the platform does know. */
const keyName = (raw: unknown): string => {
  const key = String(raw ?? "").trim().toLowerCase().replace(/\s+/g, "");
  return KEY_SPELLINGS[key] ?? key;
};

const CONTROL_ACTIONS: ControlSpec[] = [
  {
    name: "click", description: "Click once where you point.", settleMs: COMMIT_SETTLE_MS,
    properties: { ...XY, ...BUTTON }, required: ["x", "y"],
    build: async (a, to) => ({ kind: "click", point: await to(a.x, a.y), button: button(a), count: 1 }),
    summary: (a) => `Clicked ${at(a)}.`,
  },
  {
    name: "double_click", description: "Double click where you point.", settleMs: COMMIT_SETTLE_MS,
    properties: XY, required: ["x", "y"],
    build: async (a, to) => ({ kind: "click", point: await to(a.x, a.y), button: "left", count: 2 }),
    summary: (a) => `Double clicked ${at(a)}.`,
  },
  {
    name: "right_click", description: "Open the context menu where you point.",
    properties: XY, required: ["x", "y"],
    build: async (a, to) => ({ kind: "click", point: await to(a.x, a.y), button: "right", count: 1 }),
    summary: (a) => `Right clicked ${at(a)}.`,
  },
  {
    name: "move", description: "Move the pointer without pressing anything, to reveal a hover state.",
    properties: XY, required: ["x", "y"],
    build: async (a, to) => ({ kind: "move", point: await to(a.x, a.y) }),
    summary: (a) => `Moved the pointer to ${at(a)}.`,
  },
  {
    name: "drag", description: "Press at one point, move, and release at another.",
    properties: {
      from_x: { type: "integer" }, from_y: { type: "integer" },
      to_x: { type: "integer" }, to_y: { type: "integer" }, ...BUTTON,
    },
    required: ["from_x", "from_y", "to_x", "to_y"],
    build: async (a, to) => ({ kind: "drag", path: [await to(a.from_x, a.from_y), await to(a.to_x, a.to_y)], button: button(a) }),
    summary: (a) => `Dragged from (${a.from_x}, ${a.from_y}) to (${a.to_x}, ${a.to_y}).`,
  },
  {
    name: "scroll",
    description: "Scroll under the pointer, in notches of a wheel. Positive vertical scrolls down, positive horizontal scrolls right.",
    properties: {
      ...XY,
      horizontal: { type: "integer", description: "Notches right, negative for left. Defaults to 0" },
      vertical: { type: "integer", description: "Notches down, negative for up. Defaults to 0" },
    },
    required: ["x", "y"],
    build: async (a, to) => {
      const [horizontal, vertical] = [notches(a.horizontal), notches(a.vertical)];
      if (horizontal === 0 && vertical === 0) throw new Error("A scroll of nothing does nothing: give a vertical or a horizontal distance.");
      return { kind: "scroll", point: await to(a.x, a.y), horizontal, vertical };
    },
    summary: (a) => `Scrolled at ${at(a)}.`,
  },
  {
    name: "type", description: "Type text into whatever has keyboard focus. For putting the user's own words in their document, use insert_text instead.",
    properties: { text: { type: "string" } }, required: ["text"],
    build: async (a) => ({ kind: "type", text: a.text }),
    summary: (a) => `Typed ${String(a.text).length} characters.`,
  },
  {
    name: "keypress", description: "Press a chord, as [\"cmd\", \"s\"] or [\"enter\"]. Enter usually commits something, so read the screen that comes back.", settleMs: COMMIT_SETTLE_MS,
    properties: { keys: { type: "array", items: { type: "string" }, description: "The keys held together" } },
    required: ["keys"],
    build: async (a) => {
      const keys = (a.keys as unknown[]).map(keyName).filter(Boolean);
      if (!keys.length) throw new Error("A chord needs at least one key.");
      return { kind: "keypress", keys };
    },
    summary: (a) => `Pressed ${(a.keys as unknown[]).map(keyName).filter(Boolean).join("+")}.`,
  },
  {
    name: "mouse_down", description: "Press and hold a mouse button. Pair it with mouse_up for a gesture drag cannot express.",
    properties: { ...XY, ...BUTTON }, required: ["x", "y"],
    build: async (a, to) => ({ kind: "mouse_down", point: await to(a.x, a.y), button: button(a) }),
    summary: (a) => `Pressed the mouse at ${at(a)}.`,
  },
  {
    name: "mouse_up", description: "Release a held mouse button.",
    properties: { ...XY, ...BUTTON }, required: ["x", "y"],
    build: async (a, to) => ({ kind: "mouse_up", point: await to(a.x, a.y), button: button(a) }),
    summary: (a) => `Released the mouse at ${at(a)}.`,
  },
  {
    name: "window_activate", description: "Bring a window to the front and give it focus.", settleMs: COMMIT_SETTLE_MS,
    properties: { window_id: { type: "integer" } }, required: ["window_id"],
    build: async (a) => ({ kind: "window", op: "activate", windowId: a.window_id }),
    summary: (a) => `Brought window ${a.window_id} to the front.`,
  },
  {
    name: "window_move", description: "Move a window to a desktop position, in the coordinates list_windows reports.",
    properties: { window_id: { type: "integer" }, ...WINDOW_XY }, required: ["window_id", "x", "y"],
    build: async (a) => ({ kind: "window_move", windowId: a.window_id, point: screenPoint(a.x, a.y) }),
    summary: (a) => `Moved window ${a.window_id} to ${at(a)}.`,
  },
  {
    name: "window_resize", description: "Resize a window, in the same desktop coordinates list_windows reports.",
    properties: { window_id: { type: "integer" }, width: { type: "integer" }, height: { type: "integer" } },
    required: ["window_id", "width", "height"],
    build: async (a) => ({ kind: "window_resize", windowId: a.window_id, width: a.width, height: a.height }),
    summary: (a) => `Resized window ${a.window_id} to ${a.width} by ${a.height}.`,
  },
  {
    name: "window_minimize", description: "Send a window to the dock or taskbar.",
    properties: { window_id: { type: "integer" } }, required: ["window_id"],
    build: async (a) => ({ kind: "window", op: "minimize", windowId: a.window_id }),
    summary: (a) => `Minimized window ${a.window_id}.`,
  },
  {
    name: "window_close", description: "Close a window. Anything unsaved in it is the user's to lose, so be sure.",
    properties: { window_id: { type: "integer" } }, required: ["window_id"],
    build: async (a) => ({ kind: "window", op: "close", windowId: a.window_id }),
    summary: (a) => `Closed window ${a.window_id}.`,
  },
  {
    name: "open_app", description: "Launch an app, or bring it to the front if it is already running. Prefer this over hunting for it in the dock.", settleMs: LAUNCH_SETTLE_MS,
    properties: { name: { type: "string", description: "The app's name as the user would say it" } },
    required: ["name"],
    build: async (a) => ({ kind: "open_app", name: a.name }),
    summary: (a) => `Opened ${a.name}.`,
  },
  {
    name: "open_url", description: "Open a web address in the user's browser. Prefer this over clicking into the address bar and typing: it is one call, it cannot miss, and it works whatever the browser is showing.", settleMs: LAUNCH_SETTLE_MS,
    properties: { url: { type: "string", description: "An http or https address" } },
    required: ["url"],
    build: async (a) => ({ kind: "open_url", url: a.url }),
    summary: (a) => `Opened ${a.url}.`,
  },
];

// ── plumbing ────────────────────────────────────────────────────────────────

const obj = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: "object", properties, required, additionalProperties: false });

const describeWindow = (w: WindowSummary): string => {
  const title = w.title ? ` "${w.title}"` : "";
  return `${w.id}: ${w.appName}${title} at (${w.x}, ${w.y}) ${w.width} by ${w.height}${w.minimized ? ", minimized" : ""}`;
};

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
