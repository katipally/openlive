import type { FlowCapabilities } from "./bridge";

// Whether Flow's first run is done, kept as one flag (lib/prefs.ts; its old
// localStorage key is FLOW_ONBOARDED_KEY, for lib/migrateLocal.ts): "1" once it
// is. Its one step is access, which the app's Welcome shows the same rows of,
// so passing it there finishes this too. "access" is what a build with a second
// step wrote for that, when only the step that picked who answers was left; who
// answers is the default now, picked in Welcome, so it reads as done.

export const FLOW_ONBOARDED_KEY = "openlive-flow-onboarded";
export const FLOW_ONBOARDED_DONE = "1";
const ACCESS = "access";

/** Whether Flow's first run is still to show. */
export const flowOnboardingDue = (flag: string | null): boolean => flag !== FLOW_ONBOARDED_DONE && flag !== ACCESS;

/** The flag to write once Welcome is left: its access step counts when it was
 *  passed, or when nothing on it was left to grant. */
export function afterWelcome(flag: string | null, passedAccess: boolean, allGranted: boolean): string | null {
  return passedAccess || allGranted ? FLOW_ONBOARDED_DONE : flag;
}

/** Every grant Flow's access step asks for, the same reading as its rows. */
export function allGranted(caps: FlowCapabilities | null, consent: boolean): boolean {
  const p = caps?.permissions;
  return !!p && consent && p.microphone === "granted" && p.accessibility && p.postEvents !== false
    && p.screenRecording && caps?.report?.capture !== false;
}
