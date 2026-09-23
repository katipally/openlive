import type { FlowContextWire } from "@openlive/shared";
import type { QuietSignals } from "./quiet";

// The desktop half of Flow, as the renderer sees it. Every call resolves to a
// value: a failure inside Rust or inside the main process is `{ ok: false }`,
// never a throw, so call sites stay free of try/catch.

export type Guarded<T> = { ok: true; value: T } | { ok: false; error: string };

export interface FlowPermissions {
  accessibility: boolean;
  microphone: string;
  screenRecording: boolean;
  /** The right to POST synthetic events, where the platform reports it apart
   *  from the right to read the accessibility tree. Absent on a build that only
   *  reports one combined grant, and the UI degrades per grant on that. */
  postEvents?: boolean;
}
export interface SecureInputStatus { active: boolean; culprit?: string; changed: boolean }
/** The addon's own report, as `native/ol-input/index.d.ts` defines it. Absent on
 *  a build that predates Block 4. */
export interface CapabilityReport {
  hook: boolean;
  injection: string;
  capture: boolean;
  captureBackend: string;
  ocr: boolean;
  ocrEngine: string;
  selection: boolean;
  selectionBackend: string;
  windowControl: boolean;
  elevatedWindowInjection: boolean;
  secureInput: boolean;
  /** "x11" | "wayland" on Linux, absent elsewhere. */
  session?: string;
  /** Which external tools were found. Linux only. */
  tools: string[];
}
export interface FlowCapabilities {
  platform: string;
  wayland: boolean;
  permissions: FlowPermissions | null;
  secureInput: SecureInputStatus | null;
  hookError: string | null;
  report: CapabilityReport | null;
  /** False while the tray's quick disarm is on: the hook is suspended on purpose. */
  armed: boolean;
}
/** Flow's one gesture: two quick taps of this key, alone, anywhere on the
 *  machine — once to open Flow and once to close it. Not configurable. One
 *  gesture that is always true beats a key nobody remembers rebinding, and the
 *  addon never swallows it, so Control keeps working as Control. */
export const FLOW_TRIGGER = "ctrl";

export type FlowPermissionName = "accessibility" | "microphone" | "screen";
export type HookEffect = { kind: string; bindingId?: string };

export interface FlowBridge {
  init(): Promise<Guarded<FlowPermissions>>;
  permissions(): Promise<Guarded<FlowPermissions>>;
  /** Shows the system prompt. macOS never calls back, so the caller polls. */
  request(what: FlowPermissionName): Promise<Guarded<boolean | string>>;
  /** Continue an archived session on the next trigger. Routed to the owner renderer. */
  resumeSession(sessionId: string): void;
  onResumeSession(cb: (sessionId: string) => void): () => void;
  /** Flow's settings were written, so the runtime should re-read them. */
  settingsChanged?(): void;
  onSettingsChanged?(cb: () => void): () => void;
  /** The tray's quick disarm, and a subscription to it. */
  setArmed(armed: boolean): void;
  onArmed(cb: (armed: boolean) => void): () => void;
  /** Watch for the gesture. The key is never swallowed. */
  register(id: string, binding: string): Promise<Guarded<void>>;
  unregister(id: string): Promise<Guarded<void>>;
  suspend(): Promise<Guarded<void>>;
  resume(): Promise<Guarded<void>>;
  /** Flow closed, and the gesture was not what closed it. Without this the
   *  addon's toggle drifts out of step with what is on screen. */
  closed(): Promise<Guarded<void>>;
  insertBegin(method?: string): Promise<Guarded<number>>;
  insertPush(session: number, chunk: string): Promise<Guarded<void>>;
  insertEnd(session: number): Promise<Guarded<void>>;
  context(): Promise<Guarded<FlowContextWire>>;
  signals(): Promise<Guarded<QuietSignals>>;
  capabilities(): Promise<Guarded<FlowCapabilities>>;
  /** One perception or control call into the addon, named by `fn`. */
  device(fn: string, args: unknown): Promise<Guarded<unknown>>;
  warmOcr(): Promise<Guarded<void>>;
  summon(): void;
  dismiss(): void;
  /** The orb window is about to hide: play the exit, then call `hidden`. */
  onHiding?(cb: () => void): void;
  hidden?(): void;
  /** Whether the orb window takes clicks. False lets them through to the app
   *  underneath, which is what keeps a window parked over the dock harmless. */
  interactive(on: boolean): void;
  /** The orb window was shown, which reset it to click-through. */
  onShown?(cb: () => void): void;
  /** Bring the OpenLive window up on Flow, from the orb's full-screen control,
   *  or on Flow's settings when a failure's fix lives there. */
  expand(to?: "flow-settings"): void;
  /** The main window's side of `expand`: show Flow, because that is where the
   *  person already was. */
  onShow?(cb: (to: string) => void): () => void;
  onEffect(cb: (e: HookEffect) => void): () => void;
  onSecureInput(cb: (s: SecureInputStatus) => void): () => void;
}

export const flowBridge = (): FlowBridge | undefined =>
  typeof window === "undefined" ? undefined : (window as unknown as { openlive?: { flow?: FlowBridge } }).openlive?.flow;

/** A guarded result, or the fallback. The error is the caller's to report. */
export const valueOr = <T>(r: Guarded<T> | undefined, fallback: T): T => (r && r.ok ? r.value : fallback);
