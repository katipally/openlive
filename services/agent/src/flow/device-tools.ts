import type {
  CapabilityReport, ControlAction, DevicePort, MouseButton, ScreenPoint, ShotGeometry, WindowSummary,
} from "./device.js";
import { screenPoint, shotPoint } from "./device.js";
import type { ImagePart, Risk, TextPart, Tool, ToolResult } from "./types.js";
import type { RiskTier } from "@openlive/flow-store";

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

/** Settle time before the automatic screenshot: long enough for a menu to paint, short enough to keep a turn conversational. */
const DEFAULT_SCREENSHOT_DELAY_MS = 150;
/** A capability report is a machine fact, not a per-call one. */
const CAPABILITY_TTL_MS = 30_000;
const SHELL_OUTPUT_CAP = 4_000;

export interface DeviceToolOpts {
  device: DevicePort;
  /** Milliseconds between an action and the screenshot that shows its effect. */
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

function requireControl(caps: CapabilityReport): void {
  if (!caps.elevatedWindowInjection) {
    refuse("Input", "the window in front is running elevated, so synthetic input would be dropped without any sign of it. Ask the user to click there themselves.");
  }
}

// ── the tool set ────────────────────────────────────────────────────────────

export function deviceTools(opts: DeviceToolOpts): Tool[] {
  const { device } = opts;
  const delayMs = opts.screenshotDelayMs ?? DEFAULT_SCREENSHOT_DELAY_MS;
  const sleep = opts.sleep ?? wait;

  // The geometry of the last image the model was shown. Every coordinate it
  // sends back is in this image's space until it is shown another one.
  let lastShot: ShotGeometry | null = null;
  let caps: { at: number; report: CapabilityReport } | null = null;

  const capabilities = async (): Promise<CapabilityReport> => {
    if (caps && Date.now() - caps.at < CAPABILITY_TTL_MS) return caps.report;
    const report = await device.capabilities();
    caps = { at: Date.now(), report };
    return report;
  };

  const capture = async (target: { displayId?: number; windowId?: number }) => {
    requireCapture(await capabilities());
    const shot = await device.capture(target);
    lastShot = shot.shot;
    return shot;
  };

  /** The model's coordinate, converted by the addon. Nothing here does the arithmetic. */
  const toScreen = async (x: number, y: number): Promise<ScreenPoint> => {
    if (!lastShot) throw new Error("I do not know what the screen looks like yet. Take a screenshot first, then use the coordinates from it.");
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
  const withAutoScreenshot = (tool: Tool): Tool => ({
    ...tool,
    async execute(args, ctx) {
      const r = await tool.execute(args, ctx);
      if (r.terminate) return r;
      await sleep(delayMs);
      try {
        const { png, shot } = await capture({});
        return { ...r, content: [...r.content, text(`The screen now, ${shot.width} by ${shot.height}:`), image(png)] };
      } catch (e) {
        // The action itself worked. Saying so without a picture beats failing it.
        return { ...r, content: [...r.content, text(`I cannot show you the result: ${msg(e)}`)] };
      }
    },
  });

  const perception: Tool[] = [
    {
      name: "screenshot",
      description: "Look at the screen. Returns a picture of a display, or of one window, with the size you must use for coordinates.",
      parameters: obj({ display_id: { type: "integer", description: "Which display. Omit for the one in front." }, window_id: { type: "integer", description: "Capture just this window instead." } }, []),
      tier: "read",
      risk: "safe",
      promptGuidelines: [
        "Take a screenshot before clicking anything, and use the coordinates of the image you were given: everything you point at, including the positions read_screen_text gives you, is in that image's space.",
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
      tier: "read",
      risk: "safe",
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
      name: "list_windows",
      description: "Every open window: the app, the window title when the system will say it, and its position and size in desktop coordinates. Those are not screenshot coordinates: to click something in a window, take a screenshot.",
      parameters: obj({}, []),
      tier: "read",
      risk: "safe",
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
      tier: "read",
      risk: "safe",
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
      tier: "read",
      risk: "safe",
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
    tier: spec.tier,
    risk: spec.risk,
    async execute(args: Record<string, any>) {
      requireControl(await capabilities());
      const action = await spec.build(args, toScreen);
      await device.control(action);
      const summary = spec.summary(args);
      return { content: [text(summary)], details: { action: summary } };
    },
  }));

  const shell: Tool<{ command: string }, { code: number; stdout: string; stderr: string }> = {
    name: "shell",
    description: "Run a shell command on the user's machine and read its output. Use it for things a command does well, never for clicking around an app.",
    parameters: obj({ command: { type: "string", description: "The command line to run" } }, ["command"]),
    tier: "destructive",
    risk: "dangerous",
    promptGuidelines: ["A shell command is always confirmed out loud, so say what you are about to run in the same breath."],
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
  properties: Record<string, unknown>;
  required: string[];
  tier: RiskTier;
  risk: Risk;
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
const at = (a: { x: number; y: number }) => `(${a.x}, ${a.y})`;

const CONTROL_ACTIONS: ControlSpec[] = [
  {
    name: "click", description: "Click once where you point.",
    properties: { ...XY, ...BUTTON }, required: ["x", "y"], tier: "control", risk: "confirm",
    build: async (a, to) => ({ kind: "click", point: await to(a.x, a.y), button: button(a), count: 1 }),
    summary: (a) => `Clicked ${at(a)}.`,
  },
  {
    name: "double_click", description: "Double click where you point.",
    properties: XY, required: ["x", "y"], tier: "control", risk: "confirm",
    build: async (a, to) => ({ kind: "click", point: await to(a.x, a.y), button: "left", count: 2 }),
    summary: (a) => `Double clicked ${at(a)}.`,
  },
  {
    name: "right_click", description: "Open the context menu where you point.",
    properties: XY, required: ["x", "y"], tier: "control", risk: "confirm",
    build: async (a, to) => ({ kind: "click", point: await to(a.x, a.y), button: "right", count: 1 }),
    summary: (a) => `Right clicked ${at(a)}.`,
  },
  {
    name: "move", description: "Move the pointer without pressing anything, to reveal a hover state.",
    properties: XY, required: ["x", "y"], tier: "control", risk: "confirm",
    build: async (a, to) => ({ kind: "move", point: await to(a.x, a.y) }),
    summary: (a) => `Moved the pointer to ${at(a)}.`,
  },
  {
    name: "drag", description: "Press at one point, move, and release at another.",
    properties: {
      from_x: { type: "integer" }, from_y: { type: "integer" },
      to_x: { type: "integer" }, to_y: { type: "integer" }, ...BUTTON,
    },
    required: ["from_x", "from_y", "to_x", "to_y"], tier: "control", risk: "confirm",
    build: async (a, to) => ({ kind: "drag", path: [await to(a.from_x, a.from_y), await to(a.to_x, a.to_y)], button: button(a) }),
    summary: (a) => `Dragged from (${a.from_x}, ${a.from_y}) to (${a.to_x}, ${a.to_y}).`,
  },
  {
    name: "scroll", description: "Scroll under the pointer. Positive vertical scrolls down.",
    properties: { ...XY, horizontal: { type: "integer", description: "Defaults to 0" }, vertical: { type: "integer", description: "Defaults to 0" } },
    required: ["x", "y"], tier: "control", risk: "confirm",
    build: async (a, to) => ({ kind: "scroll", point: await to(a.x, a.y), horizontal: a.horizontal ?? 0, vertical: a.vertical ?? 0 }),
    summary: (a) => `Scrolled at ${at(a)}.`,
  },
  {
    name: "type", description: "Type text into whatever has keyboard focus. For putting the user's own words in their document, use insert_text instead.",
    properties: { text: { type: "string" } }, required: ["text"], tier: "control", risk: "confirm",
    build: async (a) => ({ kind: "type", text: a.text }),
    summary: (a) => `Typed ${String(a.text).length} characters.`,
  },
  {
    name: "keypress", description: "Press a chord, as [\"cmd\", \"s\"] or [\"enter\"].",
    properties: { keys: { type: "array", items: { type: "string" }, description: "The keys held together" } },
    required: ["keys"], tier: "control", risk: "confirm",
    build: async (a) => ({ kind: "keypress", keys: a.keys }),
    summary: (a) => `Pressed ${(a.keys as string[]).join("+")}.`,
  },
  {
    name: "mouse_down", description: "Press and hold a mouse button. Pair it with mouse_up for a gesture drag cannot express.",
    properties: { ...XY, ...BUTTON }, required: ["x", "y"], tier: "control", risk: "confirm",
    build: async (a, to) => ({ kind: "mouse_down", point: await to(a.x, a.y), button: button(a) }),
    summary: (a) => `Pressed the mouse at ${at(a)}.`,
  },
  {
    name: "mouse_up", description: "Release a held mouse button.",
    properties: { ...XY, ...BUTTON }, required: ["x", "y"], tier: "control", risk: "confirm",
    build: async (a, to) => ({ kind: "mouse_up", point: await to(a.x, a.y), button: button(a) }),
    summary: (a) => `Released the mouse at ${at(a)}.`,
  },
  {
    name: "window_activate", description: "Bring a window to the front and give it focus.",
    properties: { window_id: { type: "integer" } }, required: ["window_id"], tier: "control", risk: "confirm",
    build: async (a) => ({ kind: "window", op: "activate", windowId: a.window_id }),
    summary: (a) => `Brought window ${a.window_id} to the front.`,
  },
  {
    name: "window_move", description: "Move a window to a desktop position, in the coordinates list_windows reports.",
    properties: { window_id: { type: "integer" }, ...WINDOW_XY }, required: ["window_id", "x", "y"], tier: "control", risk: "confirm",
    build: async (a) => ({ kind: "window_move", windowId: a.window_id, point: screenPoint(a.x, a.y) }),
    summary: (a) => `Moved window ${a.window_id} to ${at(a)}.`,
  },
  {
    name: "window_resize", description: "Resize a window, in the same desktop coordinates list_windows reports.",
    properties: { window_id: { type: "integer" }, width: { type: "integer" }, height: { type: "integer" } },
    required: ["window_id", "width", "height"], tier: "control", risk: "confirm",
    build: async (a) => ({ kind: "window_resize", windowId: a.window_id, width: a.width, height: a.height }),
    summary: (a) => `Resized window ${a.window_id} to ${a.width} by ${a.height}.`,
  },
  {
    name: "window_minimize", description: "Send a window to the dock or taskbar.",
    properties: { window_id: { type: "integer" } }, required: ["window_id"], tier: "control", risk: "confirm",
    build: async (a) => ({ kind: "window", op: "minimize", windowId: a.window_id }),
    summary: (a) => `Minimized window ${a.window_id}.`,
  },
  {
    name: "window_close", description: "Close a window. Anything unsaved in it is the user's to lose, so be sure.",
    properties: { window_id: { type: "integer" } }, required: ["window_id"], tier: "control", risk: "confirm",
    build: async (a) => ({ kind: "window", op: "close", windowId: a.window_id }),
    summary: (a) => `Closed window ${a.window_id}.`,
  },
  {
    name: "open_app", description: "Launch an app, or bring it to the front if it is already running.",
    properties: { name: { type: "string", description: "The app's name as the user would say it" } },
    required: ["name"], tier: "control", risk: "confirm",
    build: async (a) => ({ kind: "open_app", name: a.name }),
    summary: (a) => `Opened ${a.name}.`,
  },
  {
    name: "open_url", description: "Open a web address in the user's browser.",
    properties: { url: { type: "string", description: "An http or https address" } },
    required: ["url"], tier: "control", risk: "confirm",
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
