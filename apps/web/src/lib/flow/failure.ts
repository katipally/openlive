import type { FlowFailure } from "./types";

// Nothing silent. Every way Flow can be unable to do its job has a state with a
// cause and exactly one thing the user can press, and each is derived from a
// capability that was actually read rather than assumed.

export interface FlowHealth {
  platform: string;
  /** Wayland cannot deliver a global hook on every compositor. */
  wayland: boolean;
  /** null when the addon could not be reached at all. */
  accessibility: boolean | null;
  secureInput: boolean;
  /** The message the hook thread died with, when it did. */
  hookError: string | null;
  /** A provider with a usable key resolved. */
  brainReady: boolean;
  online: boolean;
  /** The on-device voice weights are already downloaded. */
  modelsCached: boolean;
}

/**
 * The most blocking truth first: a hook that never installed beats a missing
 * grant, and both beat anything Flow could still half-do.
 */
export function deriveFailure(h: FlowHealth): FlowFailure | null {
  if (h.hookError) {
    return { code: "hook_failed", title: "Flow's key listener stopped", detail: h.hookError, actionLabel: "Try again" };
  }
  if (h.accessibility === false) {
    return {
      code: "no_accessibility",
      title: "I can hear you, but I cannot type for you",
      detail: `${h.platform === "darwin" ? "macOS has not given OpenLive Accessibility access" : "Your system has not given OpenLive input access"}, so nothing can be inserted. Your words are still here.`,
      actionLabel: "Open settings",
    };
  }
  if (h.wayland) {
    return {
      code: "wayland",
      title: "Wayland will not hand out a global key",
      detail: "This compositor blocks the system-wide hook, so the double tap cannot reach Flow here. Chat and calls in the OpenLive window still work.",
    };
  }
  if (h.secureInput) {
    return {
      code: "secure_input",
      title: "A password field has the keyboard",
      detail: "Secure input is on, so key presses are hidden from every app including this one. It clears when you leave the field.",
    };
  }
  if (!h.brainReady) {
    return {
      code: "no_provider",
      title: "No brain is configured yet",
      detail: "Flow needs a provider key, or a coding agent to think with. Nothing was sent anywhere.",
      actionLabel: "Choose one",
    };
  }
  if (!h.online) {
    return {
      code: "offline",
      title: "You are offline",
      detail: "I kept what you said. Send it again when the connection is back.",
      actionLabel: "Try again",
    };
  }
  if (!h.modelsCached) {
    return {
      code: "models_missing",
      title: "The voice models are not downloaded yet",
      detail: "Flow listens and speaks on-device, so it needs them once. It is about a hundred megabytes.",
      actionLabel: "Download",
    };
  }
  return null;
}
