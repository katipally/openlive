import type { QuietReason } from "./types";

// Whether this turn is spoken out loud. Both halves of the rule live here: the
// heuristics, and the user's own toggle, which beats every one of them in both
// directions and is remembered for the session.

/** What the desktop could actually read. `null` means "could not tell", never "no". */
export interface QuietSignals {
  /** The foreground app's name, when the platform can report one. */
  app: string | null;
  /** A call is up right now, read from processes that only exist during one. */
  inCall: boolean | null;
  dnd: boolean | null;
  outputMuted: boolean | null;
  micBusy: boolean | null;
}

export interface QuietRules {
  speakReplies: boolean;
  meetingApps: boolean;
  micContention: boolean;
  systemDnd: boolean;
  /** The user's own additions, matched against the foreground app. */
  apps: string[];
}

// Matched as lowercase substrings against the foreground app, so "zoom" catches
// "zoom.us" and "Teams" catches both of Microsoft's executables.
const MEETING_APPS = [
  "zoom", "teams", "webex", "bluejeans", "gotomeeting", "ringcentral", "skype",
  "facetime", "discord", "whereby", "around", "gather", "chime", "lifesize", "slack huddle",
];

export const NO_SIGNALS: QuietSignals = { app: null, inCall: null, dnd: null, outputMuted: null, micBusy: null };

/** Why Flow is staying quiet this turn, or "" when it will speak. */
export function decideQuiet(signals: QuietSignals, rules: QuietRules, override: boolean | null): QuietReason {
  if (override === true) return "";
  if (override === false) return "off";
  if (!rules.speakReplies) return "off";

  const app = (signals.app ?? "").toLowerCase();
  const meeting = [...MEETING_APPS, ...rules.apps.map((a) => a.toLowerCase())].filter(Boolean);
  if (rules.meetingApps && (signals.inCall === true || (!!app && meeting.some((m) => app.includes(m))))) return "meeting";
  if (rules.micContention && signals.micBusy === true) return "mic_busy";
  if (rules.systemDnd && signals.dnd === true) return "dnd";
  if (signals.outputMuted === true) return "output_muted";
  return "";
}

/** The line the pill shows next to its speaker toggle. */
export function quietLabel(reason: QuietReason): string {
  switch (reason) {
    case "meeting": return "You are in a call, so this one is written down.";
    case "mic_busy": return "Something else is using the microphone, so this one is written down.";
    case "dnd": return "Do Not Disturb is on, so this one is written down.";
    case "output_muted": return "Your output is muted, so this one is written down.";
    case "off": return "Speaking is off.";
    default: return "";
  }
}
