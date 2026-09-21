/** A hold-to-talk effect emitted by the coordinator on the hook thread. */
export interface HookEffect {
  /** "start" | "stop" | "cancel" */
  kind: string;
  /** Absent on "cancel". */
  bindingId?: string;
}

export interface BindingInfo {
  canonical: string;
  modifierOnly: boolean;
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
  /** "granted" | "denied" | "undetermined" | "restricted" */
  microphone: string;
  screenRecording: boolean;
}

export type Activation = "toggle" | "pushToTalk" | "holdOrToggle";
export type InsertionMethod = "paste" | "type";

/** Idempotent. Resolves the keyboard layout; no permission prompt. */
export function initializeInjector(): void;
/** Idempotent. Installs the global hook, which is what asks for Accessibility. */
export function initializeHook(onEffect: (effect: HookEffect) => void): void;
/** Drops the hook and ends every open insertion session. */
export function shutdown(): void;
/** The error the hook thread died with, or null while it is healthy. */
export function hookError(): string | null;

export function parseBinding(binding: string): BindingInfo;
export function registerBinding(id: string, binding: string, activation: Activation, holdThresholdMs: number): void;
export function unregisterBinding(id: string): void;
export function suspendHook(): void;
export function resumeHook(): void;

/** Programmatic trigger. Never debounced. */
export function triggerExternal(id: string, pressed: boolean): void;
export function notifyProcessingFinished(): void;
export function notifyStartFailed(): void;

export function insertText(text: string, insertionMethod?: InsertionMethod): void;
export function beginInsertion(insertionMethod?: InsertionMethod): number;
export function pushInsertion(session: number, chunk: string): void;
export function endInsertion(session: number): void;

/** Poll at 1Hz from the main thread. */
export function secureInputStatus(): SecureInputStatus;
/** Null when a binding may be recorded, otherwise the reason it may not. */
export function bindingRecordingRefusal(): string | null;

export function permissionStatus(): PermissionStatus;
export function requestAccessibility(): boolean;
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
  /** Screen coordinates, so this is clickable as it stands. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CapabilityReport {
  hook: boolean;
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
/** Runs off the main thread. Boxes come back in screen coordinates. */
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

export function moveMouse(point: Point): void;
export function click(point: Point, mouseButton?: MouseButton, count?: number): void;
export function doubleClick(point: Point): void;
export function rightClick(point: Point): void;
export function mouseDown(point: Point, mouseButton?: MouseButton): void;
export function mouseUp(point: Point, mouseButton?: MouseButton): void;
/** The whole path, not just its ends. */
export function drag(path: Point[], mouseButton?: MouseButton): void;
export function scroll(point: Point, horizontal: number, vertical: number): void;
export function typeText(text: string): void;
/** A chord, as ["ctrl", "c"]. */
export function keypress(keys: string[]): void;

/** What this machine can do right now. Safe to call on demand. */
export function capabilities(): CapabilityReport;
