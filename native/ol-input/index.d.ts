/** An effect emitted by the coordinator on the hook thread. */
export interface HookEffect {
  /** "double_tap": a toggle binding's gesture. It carries no direction: whoever
   *  owns the mode knows whether it is open.
   *  "hold_start" | "hold_end" | "hold_cancel": a hold binding was pressed,
   *  released after a hold, or let go as a tap or a chord. */
  kind: string;
  bindingId?: string;
}

/** "toggle" reports two quick taps of the key, alone; "hold" reports it held (push to talk). */
export type BindingRole = "toggle" | "hold";

/** The Advanced timing of Settings > General > Typing at cursor, in ms. A field left out keeps its default
 *  (50, 200 and 8000); each is capped (1000, 5000 and 60000). */
export interface InsertionTiming {
  /** How long the modifier is held either side of the paste key. */
  modifierHoldMs?: number;
  /** How long after the app last read the clipboard before the user's copy goes back. */
  clipboardQuietMs?: number;
  /** The longest the pasted text may hold the clipboard. */
  clipboardTimeoutMs?: number;
  /** Off, the inserted text stays on the clipboard. Defaults to on. */
  restoreClipboard?: boolean;
}

export interface SecureInputStatus {
  active: boolean;
  /** Best effort. macOS does not name the process that enabled it. */
  culprit?: string;
  /** True only on the poll that saw the state flip. */
  changed: boolean;
}

export interface PermissionStatus {
  accessibility: boolean;
  /** Whether this process may post keystrokes and clicks. A separate grant
   *  from accessibility: a process can read the AX tree and still have every
   *  event it posts silently discarded. */
  postEvents: boolean;
  /** "granted" | "denied" | "undetermined" | "restricted" */
  microphone: string;
  screenRecording: boolean;
}

export type InsertionMethod = "paste" | "type";

/** Idempotent. Resolves the keyboard layout and asks for post-event access,
 *  which prompts on macOS, so onboarding is the only caller.
 *  Returns whether this process may now post events. */
export function initializeInjector(): boolean;
/** Idempotent. Installs the global hook, which is what asks for Accessibility. */
export function initializeHook(onEffect: (effect: HookEffect) => void): void;
/** Drops the hook and ends every open insertion session. */
export function shutdown(): void;
/** The error the hook thread died with, or null while it is healthy. */
export function hookError(): string | null;

/** Watches `binding` in its role. A modifier is never swallowed: it keeps
 *  working as itself in whatever app is in front. A hold binding on a key that
 *  types (F13 to F24) is kept from the app in front. A toggle never shares a
 *  physical key with a hold binding: it is narrowed away from it (see `narrowToggle`). */
export function registerBinding(id: string, binding: string, role: BindingRole): void;
/** `toggle` as the hook watches it while `hold` is the push-to-talk key ("ctrl"
 *  beside "ctrl_right" is "ctrl_left"), or null when the hold key takes all of it. */
export function narrowToggle(toggle: string, hold: string): string | null;
export function unregisterBinding(id: string): void;
/** One binding by id, or the whole hook. */
export function suspendHook(id?: string): void;
export function resumeHook(id?: string): void;

/** Programmatic trigger: a toggle's one call is the whole gesture, a hold's `pressed` is its edge. */
export function triggerExternal(id: string, pressed: boolean): void;

/** Resolves once the text has landed, and rejects when it did not. Runs off
 *  the main thread: the paste receipt arrives on the main thread's run loop. */
export function insertText(text: string, insertionMethod?: InsertionMethod, insertionTiming?: InsertionTiming): Promise<void>;
export function beginInsertion(insertionMethod?: InsertionMethod, insertionTiming?: InsertionTiming): number;
export function pushInsertion(session: number, chunk: string): void;
/** Resolves once everything pushed into the session has been typed. */
export function endInsertion(session: number): Promise<void>;

/** Poll at 1Hz from the main thread. */
export function secureInputStatus(): SecureInputStatus;

export function permissionStatus(): PermissionStatus;
export function requestAccessibility(): boolean;
/** Shows the post-event prompt. Onboarding only. */
export function requestPostEvents(): boolean;
export function requestMicrophone(): string;
export function requestScreenRecording(): boolean;

/**
 * Whether anything on this machine is holding the microphone right now.
 * `null` means the platform would not say, which is never "nothing is using it".
 * macOS reads CoreAudio's device state; Windows and Linux have no cheap answer.
 */
export function microphoneInUse(): boolean | null;

/** A display, in logical screen coordinates. */
export interface DisplayInfo {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Image pixels per logical point. Reported, never applied to a coordinate. */
  scale: number;
  primary: boolean;
}

/**
 * The geometry a captured image is in. It travels with the image, and
 * `shotToScreen` is the only way from a pixel in that image to a coordinate
 * the control calls accept.
 */
export interface ShotGeometry {
  originX: number;
  originY: number;
  scale: number;
  /** The capped size, which is also the size advertised to the model. */
  width: number;
  height: number;
}

export interface CaptureResult {
  png: Buffer;
  shot: ShotGeometry;
}

/** Screen coordinates. Never screenshot pixels. */
export interface Point {
  x: number;
  y: number;
}

export interface WindowSummary {
  id: number;
  appName: string;
  /** Bundle id on macOS, executable name elsewhere. */
  appId?: string;
  /** Absent when the platform withholds it, never an empty string. */
  title?: string;
  pid: number;
  x: number;
  y: number;
  width: number;
  height: number;
  displayId?: number;
  minimized: boolean;
}

export interface TextBoxInfo {
  text: string;
  confidence: number;
  /** Coordinates in the image the text was read from, as `shotToScreen` takes them. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CapabilityReport {
  hook: boolean;
  /** False when everything this process types or clicks is discarded by the OS. */
  postEvents: boolean;
  injection: InsertionMethod;
  capture: boolean;
  captureBackend: string;
  ocr: boolean;
  ocrEngine: string;
  selection: boolean;
  selectionBackend: string;
  windowControl: boolean;
  /** False when injecting into the window in front would be silently dropped. */
  elevatedWindowInjection: boolean;
  secureInput: boolean;
  /** "x11" | "wayland" on Linux, absent elsewhere. */
  session?: string;
  /** Which external tools were found. Linux only. */
  tools: string[];
}

export type MouseButton = "left" | "right" | "middle";

export function displays(): DisplayInfo[];
/** Runs off the main thread. Images are capped at 1024x768. */
export function captureDisplay(displayId: number): Promise<CaptureResult>;
export function captureWindow(windowId: number): Promise<CaptureResult>;
export function captureRegion(origin: Point, width: number, height: number): Promise<CaptureResult>;
/** Screenshot pixel to screen coordinate, against the geometry that image came with. */
export function shotToScreen(shot: ShotGeometry, x: number, y: number): Point;
/** Runs off the main thread. Boxes are in the image's own pixels, so a caller
 *  that wants to click one puts it through `shotToScreen` exactly once. */
export function recognizeText(png: Buffer, shot: ShotGeometry): Promise<TextBoxInfo[]>;

/** Cheap, and needs no screen-recording permission. */
export function foregroundWindow(): WindowSummary | null;
export function windowList(): WindowSummary[];
export function activateWindow(windowId: number): void;
export function moveWindow(windowId: number, origin: Point): void;
export function resizeWindow(windowId: number, width: number, height: number): void;
export function minimizeWindow(windowId: number): void;
export function closeWindow(windowId: number): void;
export function openApp(name: string): void;
/** http and https only. */
export function openUrl(url: string): void;
/** Null when the app or the platform will not say, not when nothing is selected. */
export function selectedText(): string | null;
/** The selection in the app in front, read only through the accessibility
 *  API (AX, UI Automation, AT-SPI on X11): "" for none, null where it cannot
 *  be read that way. Never copies, and never reads Linux's PRIMARY. */
export function accessibleSelection(): Promise<string | null>;
/** Whether the focused element takes typed text. Null when the platform or the app will not say. */
export function focusEditable(): Promise<boolean | null>;
/** Lets the process `pid` raise a window, which Windows only allows the process in front. False elsewhere, and when refused. */
export function allowSetForegroundWindow(pid: number): boolean;
/** macOS: a click on the window with this native handle never activates OpenLive. False elsewhere, and when it cannot be done. */
export function preventActivation(handle: Buffer): boolean;

/**
 * Where the pointer is now, or null when the platform will not say, which is
 * never the origin.
 */
export function cursorPosition(): Point | null;

/**
 * Every control call runs off the main thread and resolves when the action has
 * finished, which for anything that moves the pointer is as long as the
 * movement takes: the pointer travels along a planned path rather than
 * teleporting, because an app that never saw it arrive opens no menu and arms
 * no drop target.
 */
export function moveMouse(point: Point): Promise<void>;
export function click(point: Point, mouseButton?: MouseButton, count?: number): Promise<void>;
export function doubleClick(point: Point): Promise<void>;
export function rightClick(point: Point): Promise<void>;
export function mouseDown(point: Point, mouseButton?: MouseButton): Promise<void>;
/** Released where it is asked to be: a held button is dragged there first. */
export function mouseUp(point: Point, mouseButton?: MouseButton): Promise<void>;
/** The whole path, not just its ends. */
export function drag(path: Point[], mouseButton?: MouseButton): Promise<void>;
/** Notches, not pixels. Positive scrolls down, and to the right, everywhere. */
export function scroll(point: Point, horizontal: number, vertical: number): Promise<void>;
export function typeText(text: string): Promise<void>;
/** A chord, as ["ctrl", "c"]. The last key is pressed `times` times (once when left out, at most 2000) while the modifiers stay down. */
export function keypress(keys: string[], times?: number): Promise<void>;

/** What this machine can do right now. Safe to call on demand. */
export function capabilities(): CapabilityReport;
