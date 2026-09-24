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
  /** What that download holds for the selected engines (browserModels). */
  voiceModels: string[];
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
      settings: "flow",
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
      detail: `Flow listens and speaks on-device, so it needs the ${listed(h.voiceModels)} ${h.voiceModels.length > 1 ? "models" : "model"} once.`,
      actionLabel: "Download",
    };
  }
  return null;
}

/** "a", "a and b", "a, b and c". */
const listed = (xs: string[]): string => xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : xs[0] ?? "";

/** The provider's own sentence out of an `HTTP 400: {"error":{"message":...}}` body. */
const said = (message: string): string =>
  (/"message"\s*:\s*"((?:[^"\\]|\\.)+)"/.exec(message)?.[1] ?? message).replace(/\\(.)/g, "$1").trim().slice(0, 240);

/**
 * A turn the brain failed, as the card it gets. The error text is all that
 * crosses the socket, so the cause is read from it: the status codes and words
 * every provider and agent uses for the same four problems. `agent` is whether
 * the brain is a coding agent, whose sign-in and model are set elsewhere than
 * API mode's key and model.
 */
export function turnFailure(message: string, agent = false): FlowFailure {
  const m = message;
  if (/no api key/i.test(m)) {
    return { code: "brain_setup", title: "API mode has no key yet", detail: `${said(m)} Your words were not sent anywhere.`, actionLabel: "Open settings", settings: "models" };
  }
  if (/\b40[13]\b|invalid.{0,20}(api.?)?key|authenticat|unauthori[sz]ed|x-api-key|forbidden|permission_denied/i.test(m)) {
    return { code: "brain_setup", title: "The key or sign-in was refused", detail: said(m), actionLabel: "Open settings", settings: agent ? "agents" : "models" };
  }
  if (/\b404\b|model.{0,40}(not found|does not exist|not available|unsupported)|unknown model|not_found_error/i.test(m)) {
    return { code: "brain_setup", title: "That model is not available", detail: `${said(m).replace(/[.!?]?$/, ".")} Pick another in settings.`, actionLabel: "Open settings", settings: agent ? "flow" : "models" };
  }
  if (/quota|insufficient|billing|credit/i.test(m)) {
    return { code: "turn_failed", title: "The provider says the account is out of credit", detail: said(m) };
  }
  if (/\b429\b|rate.?limit|too many requests|overloaded|\b529\b/i.test(m)) {
    return { code: "turn_failed", title: "The provider is busy right now", detail: "It asked for a pause. Say it again in a moment." };
  }
  if (/could not reach|fetch failed|econnrefused|enotfound|econnreset|etimedout|network|socket hang up/i.test(m)) {
    // The brain names the address it tried when it knows it; that is the thing to
    // check, and the address is set in Models.
    if (/^could not reach/i.test(m)) return { code: "turn_failed", title: "I could not reach the model", detail: said(m), actionLabel: "Open settings", settings: "models" };
    return { code: "turn_failed", title: "I could not reach the model", detail: "Check the connection. For a local model, check that Ollama is running." };
  }
  return { code: "turn_failed", title: "That turn failed", detail: said(m) || "The brain stopped without saying why." };
}
