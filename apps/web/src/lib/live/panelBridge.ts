import type { LivePhase, PendingPermission } from "./liveStore";
import type { FlowFailureCode, FlowSnapshot } from "@/lib/flow/types";

// Wire shape between a renderer that runs a voice pipeline (Flow's owner, or the
// main window during a call) and the desktop orb window, relayed through the
// Electron main process.
export interface PanelStateSnapshot {
  phase: LivePhase; muted: boolean; cameraOn: boolean; screenOn: boolean;
  userCaption: string; userPartial: boolean; agentCaption: string;
  toolStatus: string; warming: boolean; pttActive: boolean; pttEnabled: boolean;
  holdUntil: number | null; holdMs: number;
  permission: PendingPermission | null;
  /** Present only on the Flow orb's packets. Flow has no call, no camera and no
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
  | { k: "b"; mic: number[]; agent: number[] };          // orb spectrum (~15 fps)

export type PanelCmd =
  // The call's, forwarded by the main process from the orb's call controls.
  | { t: "mute" } | { t: "end" }
  | { t: "permission"; optionId: string }
  // Flow. `flowCancel` closes Flow; `flowStop` only drops what it is doing and
  // goes back to listening, which is what someone watching it act wants.
  // `flowSpeaker` is the manual auto-quiet override, which wins in both
  // directions and is remembered for the session; `flowFix` is the one action a
  // failure state offers.
  | { t: "flowCancel" } | { t: "flowStop" } | { t: "flowSpeaker" } | { t: "flowFix"; code: FlowFailureCode };

/** A live call as the orb shows it while the main window is out of sight. */
export interface CallOrbState { muted: boolean; startedAt: number }
/** What the orb's call controls ask for. `expand` brings the main window back. */
export type CallCmd = { t: "mute" } | { t: "end" } | { t: "expand" };

export interface PanelBridgeApi {
  panelState?: (p: PanelPacket) => void;
  onPanelState?: (cb: (p: PanelPacket) => void) => void;
  panelCmd?: (c: PanelCmd) => void;
  onPanelCmd?: (cb: (c: PanelCmd) => void) => () => void;
  callState?: (s: CallOrbState | null) => void;
  onCallOrb?: (cb: (s: CallOrbState | null) => void) => void;
  callCmd?: (c: CallCmd) => void;
}

/** The desktop preload bridge, if present (undefined in the plain browser). */
export const openliveBridge = (): PanelBridgeApi | undefined =>
  typeof window === "undefined" ? undefined : (window as unknown as { openlive?: PanelBridgeApi }).openlive;

// ── Panel-command routing ────────────────────────────────────────────────────
// The preload keeps ONE listener per channel (replace-on-subscribe), so command
// handling must live in a single module-level router. The live call registers
// its handler while it runs; with none, a command has nothing to act on.
type CmdHandler = (c: PanelCmd) => void;
let cmdHandler: CmdHandler | null = null;
let wired = false;

export function wirePanelCmdRouter(): void {
  if (wired) return;
  const api = openliveBridge();
  if (!api?.onPanelCmd) return;
  wired = true;
  api.onPanelCmd((c) => cmdHandler?.(c));
}

export function setPanelCmdHandler(h: CmdHandler | null): void {
  cmdHandler = h;
}
