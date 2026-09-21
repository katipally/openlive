// The device seam. `ol-input` lives in the Electron main process, so the agent
// service reaches it the same way it reaches the clipboard and the insertion
// session: through the tool bridge. This file is the shape of that call, not a
// second copy of the native API.

/**
 * A coordinate in the image the model was shown. `scale` and `origin` are in the
 * `ShotGeometry` the image arrived with, and only the native converter knows how
 * to apply them.
 */
export interface ShotPoint { space: "shot"; x: number; y: number }
/**
 * A coordinate the control calls accept. `shotToScreen` produces one from a
 * point in an image; window geometry is already in this space, produced by the
 * window server and given straight back to it.
 */
export interface ScreenPoint { space: "screen"; x: number; y: number }

export const shotPoint = (x: number, y: number): ShotPoint => ({ space: "shot", x, y });
export const screenPoint = (x: number, y: number): ScreenPoint => ({ space: "screen", x, y });

/** Mirrors the native struct. It travels with the image it describes. */
export interface ShotGeometry {
  originX: number;
  originY: number;
  scale: number;
  /** The capped size, which is also the size advertised to the model. */
  width: number;
  height: number;
}

/** `png` is base64: the bridge carries strings. */
export interface CaptureResult { png: string; shot: ShotGeometry }

export interface DisplayInfo {
  id: number; name: string; x: number; y: number;
  width: number; height: number; scale: number; primary: boolean;
}

/** `x`, `y`, `width` and `height` are desktop coordinates: what the window
 *  server reports and what it takes back, never screenshot pixels. */
export interface WindowSummary {
  id: number; appName: string; appId?: string;
  /** Withheld without screen recording on macOS. Optional everywhere. */
  title?: string;
  pid: number; x: number; y: number; width: number; height: number;
  displayId?: number; minimized: boolean;
}

/** Positioned in the image it was read from, exactly like a point the model picks out of a screenshot. */
export interface TextBoxInfo { text: string; confidence: number; x: number; y: number; width: number; height: number }

export interface CapabilityReport {
  hook: boolean;
  injection: "paste" | "type";
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
  session?: string;
  tools: string[];
}

export type MouseButton = "left" | "right" | "middle";

/** One control call, already in screen space. The union is what the desktop dispatches on. */
export type ControlAction =
  | { kind: "move"; point: ScreenPoint }
  | { kind: "click"; point: ScreenPoint; button: MouseButton; count: number }
  | { kind: "mouse_down"; point: ScreenPoint; button: MouseButton }
  | { kind: "mouse_up"; point: ScreenPoint; button: MouseButton }
  | { kind: "drag"; path: ScreenPoint[]; button: MouseButton }
  | { kind: "scroll"; point: ScreenPoint; horizontal: number; vertical: number }
  | { kind: "type"; text: string }
  | { kind: "keypress"; keys: string[] }
  | { kind: "window"; op: "activate" | "minimize" | "close"; windowId: number }
  | { kind: "window_move"; windowId: number; point: ScreenPoint }
  | { kind: "window_resize"; windowId: number; width: number; height: number }
  | { kind: "open_app"; name: string }
  | { kind: "open_url"; url: string };

/**
 * What the machine can do, as the agent service sees it.
 *
 * Contract, relied on by every device tool: these reject with a readable message
 * rather than resolving to something empty. A black frame is a lie; an error is
 * a result the model can act on.
 */
export interface DevicePort {
  capabilities(): Promise<CapabilityReport>;
  displays(): Promise<DisplayInfo[]>;
  /** One of the two, never both. Omitting both captures the display in front. */
  capture(target: { displayId?: number; windowId?: number }): Promise<CaptureResult>;
  /** The ONLY path from an image pixel to a coordinate `control` accepts. */
  shotToScreen(shot: ShotGeometry, point: ShotPoint): Promise<ScreenPoint>;
  recognizeText(png: string, shot: ShotGeometry): Promise<TextBoxInfo[]>;
  windows(): Promise<WindowSummary[]>;
  foreground(): Promise<WindowSummary | null>;
  /** Through the existing CameraCapture the live session already owns. */
  cameraFrame(): Promise<{ data: string; mime: string } | null>;
  control(action: ControlAction): Promise<void>;
  shell(command: string): Promise<{ code: number; stdout: string; stderr: string }>;
}
