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
