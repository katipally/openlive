import type { ErrorClass } from "@openlive/shared";
import type { FlowFailure } from "./types";

// Nothing silent. Every way Flow can be unable to do its job has a state with a
// cause and exactly one thing the user can press, and each is derived from a
// capability that was actually read rather than assumed.

export interface FlowHealth {
  platform: string;
  /** null when the addon could not be reached at all. */
  accessibility: boolean | null;
  secureInput: boolean;
  /** The message the hook thread died with, when it did. */
  hookError: string | null;
  /** Why the ol-input addon did not load at all, when it did not. */
  addonError: string | null;
  /** An installed app rather than a dev checkout: decides how the addon is fixed. */
  packaged: boolean;
  /** A provider with a usable key resolved. */
  brainReady: boolean;
  online: boolean;
  /** The on-device voice weights are already downloaded. */
  modelsCached: boolean;
  /** What that download holds for the selected engines (browserModels). */
  voiceModels: string[];
}

const LINUX_INPUT_FIX = "Flow reads the keyboard from /dev/input, which takes the input group: run `sudo usermod -aG input $USER`, sign out and back in, then try again.";

/**
 * The most blocking truth first: a hook that never installed beats a missing
 * grant, and both beat anything Flow could still half-do.
 */
export function deriveFailure(h: FlowHealth): FlowFailure | null {
  if (h.addonError) return { code: "addon_missing", ...addonProblem(h.packaged), actionLabel: "Try again" };
  if (h.hookError) {
    // Linux reads keys from /dev/input on X11 and Wayland alike, which takes the input group.
    const detail = h.platform === "linux" ? `${h.hookError.replace(/[.!?]?$/, ".")} ${LINUX_INPUT_FIX}` : h.hookError;
    return { code: "hook_failed", title: "Flow's key listener stopped", detail, actionLabel: "Try again" };
  }
  if (h.accessibility === false) {
    return {
      code: "no_accessibility",
      title: "I can hear you, but I cannot type for you",
      detail: `${h.platform === "darwin" ? "macOS has not given OpenLive Accessibility access" : "Your system has not given OpenLive input access"}, so nothing can be inserted. Your words are still here.`,
      actionLabel: "Open settings",
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
 * The class of a failure read from its words, for a brain that sent no `code`:
 * an older agent, or an error made on this side of the socket.
 */
function classFromText(m: string): ErrorClass {
  if (/no api key/i.test(m)) return "no_key";
  if (/\b40[13]\b|invalid.{0,20}(api.?)?key|authenticat|unauthori[sz]ed|x-api-key|forbidden|permission_denied/i.test(m)) return "auth";
  if (/\b404\b|model.{0,40}(not found|does not exist|not available|unsupported)|unknown model|not_found_error/i.test(m)) return "model_not_found";
  if (/quota|insufficient|billing|credit/i.test(m)) return "quota";
  if (/\b429\b|rate.?limit|too many requests|overloaded|\b529\b/i.test(m)) return "rate_limited";
  if (/could not reach|fetch failed|econnrefused|enotfound|econnreset|etimedout|network|socket hang up/i.test(m)) return "unreachable";
  return "other";
}

/**
 * A turn the brain failed, as the card it gets. The wire carries a closed
 * `code` for why, so the cause is read from it; only a brain that sent none has
 * its cause read from the error text. `agent` is whether the brain is a coding
 * agent, whose sign-in and model are set elsewhere than API mode's key and model.
 */
export function turnFailure(message: string, agent = false, code?: ErrorClass): FlowFailure {
  const m = message;
  switch (code ?? classFromText(m)) {
    case "no_key":
      return { code: "brain_setup", title: "API mode has no key yet", detail: `${said(m)} Your words were not sent anywhere.`, actionLabel: "Open settings", settings: "models" };
    case "auth":
      return { code: "brain_setup", title: "The key or sign-in was refused", detail: said(m), actionLabel: "Open settings", settings: agent ? "agents" : "models" };
    case "model_not_found":
    case "no_model":
      return { code: "brain_setup", title: "That model is not available", detail: `${said(m).replace(/[.!?]?$/, ".")} Pick another in settings.`, actionLabel: "Open settings", settings: agent ? "flow" : "models" };
    case "quota":
      return { code: "turn_failed", title: "The provider says the account is out of credit", detail: said(m) };
    case "rate_limited":
      return { code: "turn_failed", title: "The provider is busy right now", detail: "It asked for a pause. Say it again in a moment." };
    case "unreachable":
      // The brain names the address it tried when it knows it; that is the thing to
      // check, and the address is set in Models.
      if (/^could not reach/i.test(m)) return { code: "turn_failed", title: "I could not reach the model", detail: said(m), actionLabel: "Open settings", settings: "models" };
      return { code: "turn_failed", title: "I could not reach the model", detail: "Check the connection. For a local model, check that Ollama is running." };
    default:
      return { code: "turn_failed", title: "That turn failed", detail: said(m) || "The brain stopped without saying why." };
  }
}

/** Flow's words for an ol-input addon that did not load, shared by the orb,
 *  Flow home and Flow settings. The raw loader error stays behind a disclosure. */
export function addonProblem(packaged: boolean): { title: string; detail: string } {
  return packaged
    ? { title: "Flow can't hear the keyboard", detail: "A part of OpenLive that Flow needs did not load. Reinstalling OpenLive puts it back." }
    : { title: "Flow's keyboard helper isn't built", detail: "Run pnpm native:build in the repo, then try again. No restart needed." };
}

/** What Flow settings says about the key listener when the double tap cannot
 *  work here, in the same words the orb uses. "" while it can. */
export function keyListenerNote(c: { hookError: string | null; wayland: boolean } | null): string {
  if (c?.hookError) return `Flow's key listener stopped: ${c.hookError}`;
  if (c?.wayland) return "On Wayland the double tap reaches Flow only when OpenLive can read /dev/input, which takes the input group. Chat and calls in the OpenLive window work either way.";
  return "";
}
