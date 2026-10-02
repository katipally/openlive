import type { FlowCapabilities } from "./bridge";

// How far Flow's first run has got, kept under one key: "1" once it is done,
// "access" once the app's Welcome covered its access step, which shows the same
// rows. Only the brain step is left then.

export const FLOW_ONBOARDED_KEY = "openlive-flow-onboarded";
export const FLOW_ONBOARDED_DONE = "1";
const ACCESS = "access";

/** The step Flow's first run opens at, or null once it is done. */
export function flowOnboardingStep(flag: string | null): 1 | 2 | null {
  return flag === FLOW_ONBOARDED_DONE ? null : flag === ACCESS ? 2 : 1;
}

/** The flag to write once Welcome is left: the access step counts when it was
 *  passed, or when nothing on it was left to grant. A finished run stays finished. */
export function afterWelcome(flag: string | null, passedAccess: boolean, allGranted: boolean): string | null {
  if (flag === FLOW_ONBOARDED_DONE || !(passedAccess || allGranted)) return flag;
  return ACCESS;
}

/** Every grant Flow's access step asks for, the same reading as its rows. */
export function allGranted(caps: FlowCapabilities | null, consent: boolean): boolean {
  const p = caps?.permissions;
  return !!p && consent && p.microphone === "granted" && p.accessibility && p.postEvents !== false
    && p.screenRecording && caps?.report?.capture !== false;
}
