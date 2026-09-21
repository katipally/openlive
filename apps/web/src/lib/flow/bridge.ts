import type { FlowContextWire } from "@openlive/shared";
import type { QuietSignals } from "./quiet";

// The desktop half of Flow, as the renderer sees it. Every call resolves to a
// value: a failure inside Rust or inside the main process is `{ ok: false }`,
// never a throw, so call sites stay free of try/catch.

export type Guarded<T> = { ok: true; value: T } | { ok: false; error: string };

export interface FlowPermissions { accessibility: boolean; microphone: string; screenRecording: boolean }
export interface SecureInputStatus { active: boolean; culprit?: string; changed: boolean }
export interface FlowCapabilities {
  platform: string;
  wayland: boolean;
  permissions: FlowPermissions | null;
  secureInput: SecureInputStatus | null;
  hookError: string | null;
}
export type HookEffect = { kind: string; bindingId?: string };
export type AddonActivation = "toggle" | "pushToTalk" | "holdOrToggle";

export interface FlowBridge {
  init(): Promise<Guarded<FlowPermissions>>;
  permissions(): Promise<Guarded<FlowPermissions>>;
  register(id: string, binding: string, activation: AddonActivation, holdMs: number): Promise<Guarded<void>>;
  unregister(id: string): Promise<Guarded<void>>;
  suspend(): Promise<Guarded<void>>;
  resume(): Promise<Guarded<void>>;
  processingFinished(): Promise<Guarded<void>>;
  startFailed(): Promise<Guarded<void>>;
  insertBegin(method?: string): Promise<Guarded<number>>;
  insertPush(session: number, chunk: string): Promise<Guarded<void>>;
  insertEnd(session: number): Promise<Guarded<void>>;
  context(): Promise<Guarded<FlowContextWire>>;
  signals(): Promise<Guarded<QuietSignals>>;
  capabilities(): Promise<Guarded<FlowCapabilities>>;
  summon(): void;
  dismiss(): void;
  size(h: number): void;
  onEffect(cb: (e: HookEffect) => void): void;
  onSecureInput(cb: (s: SecureInputStatus) => void): void;
}

export const flowBridge = (): FlowBridge | undefined =>
  typeof window === "undefined" ? undefined : (window as unknown as { openlive?: { flow?: FlowBridge } }).openlive?.flow;

/** A guarded result, or the fallback. The error is the caller's to report. */
export const valueOr = <T>(r: Guarded<T> | undefined, fallback: T): T => (r && r.ok ? r.value : fallback);

/** The addon's activation vocabulary, from the user's configured one. */
export const addonActivation = (mode: string): AddonActivation =>
  mode === "toggle" ? "toggle" : mode === "hold_or_toggle" ? "holdOrToggle" : "pushToTalk";
