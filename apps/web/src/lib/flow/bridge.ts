import type { FlowCloseReason, FlowContextWire, TelemetryEventProps } from "@openlive/shared";
import type { QuietSignals } from "./quiet";
import type { FlowSettingsPage } from "./types";

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
/** Settings > General > Typing at cursor's Advanced timing and clipboard switch. A field left out keeps the addon's default. */
export interface InsertionTiming { modifierHoldMs?: number; clipboardQuietMs?: number; clipboardTimeoutMs?: number; restoreClipboard?: boolean }
export interface SecureInputStatus { active: boolean; culprit?: string; changed: boolean }
/** The addon's own report, as `native/ol-input/index.d.ts` defines it. Absent
 *  when the addon could not be loaded. */
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
  /** Why the ol-input addon could not be loaded at all (not built, or will not
   *  load). Set instead of `hookError`: there is no hook to have stopped. */
  addonError: string | null;
  /** An installed app, where the fix is a reinstall rather than a build. */
  packaged: boolean;
  report: CapabilityReport | null;
  /** False while Flow's off switch (on Flow's home) is off: the hook is suspended on purpose. */
  armed: boolean;
}
/** The binding ids main registers with the addon (apps/desktop/flow-input.cjs),
 *  as effects name them. Flow's and Dictate's report a double tap; the
 *  push-to-talk key reports a hold. */
export const FLOW_BINDING = "flow";
export const DICTATE_BINDING = "dictate";
export const PTT_BINDING = "ptt";

export type FlowPermissionName = "accessibility" | "microphone" | "screen";
/** Which screen asked for a permission, for the onboarding funnel. */
export type PermissionAskedFrom = NonNullable<TelemetryEventProps<"os_permission_request">["asked_from"]>;
export type HookEffect = { kind: string; bindingId?: string };

export interface FlowBridge {
  init(): Promise<Guarded<FlowPermissions>>;
  permissions(): Promise<Guarded<FlowPermissions>>;
  /** Shows the system prompt, even after an earlier refusal. macOS never calls
   *  back, so the caller polls. */
  request(what: FlowPermissionName, askedFrom?: PermissionAskedFrom): Promise<Guarded<boolean | string>>;
  /** Opens the system settings page for `what`: a grant's, or macOS's Keyboard
   *  page for the Fn (Globe) key's action. False where there is none. */
  openSettings(what: FlowPermissionName | "keyboard"): Promise<Guarded<boolean>>;
  /** What macOS does on a press of Fn: 0 is Do Nothing. Null where it cannot be
   *  read or there is no Fn. Absent on a build from before it was asked. */
  fnUsage?(): Promise<Guarded<number | null>>;
  /** Continue an archived session on the next trigger. Routed to the owner renderer. */
  resumeSession(sessionId: string): void;
  onResumeSession(cb: (sessionId: string) => void): () => void;
  /** The tray's "Start Flow", and whether Flow was already open when it was chosen. */
  onNewSession?(cb: (wasOpen: boolean) => void): () => void;
  /** Flow's settings were written, so the runtime should re-read them. */
  settingsChanged?(): void;
  onSettingsChanged?(cb: () => void): () => void;
  /** Flow's off switch, and a subscription to it. */
  setArmed(armed: boolean): void;
  onArmed(cb: (armed: boolean) => void): () => void;
  suspend(): Promise<Guarded<void>>;
  resume(): Promise<Guarded<void>>;
  insertBegin(method?: string, timing?: InsertionTiming): Promise<Guarded<number>>;
  insertPush(session: number, chunk: string): Promise<Guarded<void>>;
  insertEnd(session: number): Promise<Guarded<void>>;
  /** A chord, as ["ctrl", "z"], its last key pressed `times` times. */
  keys(keys: string[], times?: number): Promise<Guarded<void>>;
  /** The selection in the app in front, by sending the copy chord; null when nothing was copied. */
  copySelection(timing?: InsertionTiming): Promise<Guarded<string | null>>;
  /** The selection in the app in front through the accessibility API alone
   *  (OpenLive's own page directly): "" for none, null where it cannot be read
   *  that way, as on Wayland. Never copies. */
  accessibleSelection(): Promise<Guarded<string | null>>;
  /** Whether the focused element takes typed text; null when the platform or the app will not say. */
  focusEditable(): Promise<Guarded<boolean | null>>;
  context(): Promise<Guarded<FlowContextWire>>;
  signals(): Promise<Guarded<QuietSignals>>;
  capabilities(): Promise<Guarded<FlowCapabilities>>;
  /** One perception or control call into the addon, named by `fn`. */
  device(fn: string, args: unknown): Promise<Guarded<unknown>>;
  warmOcr(): Promise<Guarded<void>>;
  /** "dictate" shows the orb for Dictate alone, which is not a Flow session. */
  summon(mode?: "flow" | "dictate"): void;
  /** `reason` is why it closed, for the session's summary. Omitted, it counts as "other". */
  dismiss(reason?: FlowCloseReason): void;
  /** The orb window is about to hide: play the exit, then call `hidden`. */
  onHiding?(cb: () => void): void;
  hidden?(): void;
  /** Whether the orb window takes clicks. False lets them through to the app
   *  underneath, which is what keeps a window parked over the dock harmless. */
  interactive(on: boolean): void;
  /** The orb window was shown, which reset it to click-through. */
  onShown?(cb: () => void): void;
  /** X11 only: the pointer in window coordinates, null once it leaves, since
   *  a click-through window is sent no moves there. */
  onPointer?(cb: (p: { x: number; y: number } | null) => void): () => void;
  /** Whether the orb window is on screen now, for a renderer that may have
   *  missed the `onShown` that put it there. */
  visible?(): Promise<boolean>;
  /** Bring the OpenLive window up on Flow, from the orb's full-screen control,
   *  or on the settings page where a failure's fix lives. */
  expand(to?: `${FlowSettingsPage}-settings`): void;
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
