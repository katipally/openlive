import type { LivePhase, PendingPermission } from "./liveStore";
import type { FlowFailureCode, FlowSnapshot } from "@/lib/flow/types";

// Wire shape between the hidden main renderer (voice pipeline) and the desktop
// mini PANEL window, relayed through the Electron main process. A MediaStream
// can't cross BrowserWindows, so previews travel as ~10 fps JPEG data-URLs.
export interface PanelStateSnapshot {
  phase: LivePhase; muted: boolean; cameraOn: boolean; screenOn: boolean;
  userCaption: string; userPartial: boolean; agentCaption: string;
  toolStatus: string; warming: boolean; pttActive: boolean; pttEnabled: boolean;
  holdUntil: number | null; holdMs: number;
  permission: PendingPermission | null;
  /** Present only on the Flow pill's packets. Flow has no call, no camera and no
   *  screen share, so it carries its own state rather than pretending to have one. */
  flow?: FlowSnapshot;
}

/** The fields a Flow packet has no opinion about. Spread, then add `flow`. */
export const NO_CALL: PanelStateSnapshot = {
  phase: "idle", muted: false, cameraOn: false, screenOn: false,
  userCaption: "", userPartial: false, agentCaption: "", toolStatus: "", warming: false,
  pttActive: false, pttEnabled: false, holdUntil: null, holdMs: 0, permission: null,
};

export type PanelPacket =
  | { k: "s"; s: PanelStateSnapshot }                    // store state (on change)
  | { k: "b"; mic: number[]; agent: number[] }           // orb spectrum (~15 fps)
  | { k: "f"; cam?: string; screen?: string };           // preview JPEGs (~10 fps)

export type PanelCmd =
  | { t: "mute" } | { t: "camera" } | { t: "screen" }
  | { t: "end" } | { t: "expand" } | { t: "sendNow" } | { t: "ptt" }
  | { t: "permission"; optionId: string }
  // Flow. `flowSpeaker` is the manual auto-quiet override, which wins in both
  // directions and is remembered for the session; `flowFix` is the one action a
  // failure state offers.
  | { t: "flowCancel" } | { t: "flowSpeaker" } | { t: "flowFix"; code: FlowFailureCode };

export interface PanelBridgeApi {
  mini?: () => void;
  unmini?: () => void;
  miniSize?: (h: number) => void;
  panelState?: (p: PanelPacket) => void;
  onPanelState?: (cb: (p: PanelPacket) => void) => void;
  panelCmd?: (c: PanelCmd) => void;
  onPanelCmd?: (cb: (c: PanelCmd) => void) => void;
  onPttToggle?: (cb: () => void) => void;
}

/** The desktop preload bridge, if present (undefined in the plain browser). */
export const openliveBridge = (): PanelBridgeApi | undefined =>
  typeof window === "undefined" ? undefined : (window as unknown as { openlive?: PanelBridgeApi }).openlive;

// ── Panel-command routing ────────────────────────────────────────────────────
// The preload keeps ONE listener per channel (replace-on-subscribe), so command
// handling must live in a single module-level router. PanelBridge registers its
// handler while a live call is minimized; with no handler (mini entered from the
// TRAY with no call running) the only sensible commands restore the window —
// without this fallback the pill's buttons were completely dead in that state.
type CmdHandler = (c: PanelCmd) => void;
let cmdHandler: CmdHandler | null = null;
let wired = false;

export function wirePanelCmdRouter(onRestore: () => void): void {
  if (wired) return;
  const api = openliveBridge();
  if (!api?.onPanelCmd) return;
  wired = true;
  api.onPanelCmd((c) => {
    if (cmdHandler) return cmdHandler(c);
    if (c.t === "expand" || c.t === "end") { onRestore(); api.unmini?.(); }
  });
}

export function setPanelCmdHandler(h: CmdHandler | null): void {
  cmdHandler = h;
}
