import type { LanguageCode } from "@openlive/shared";
import { buildLivePrompt, withLanguage } from "../prompt.js";
import { buildFlowPrompt } from "../flow/prompt.js";
import { askEach, consentApprove, type ConsentOpts } from "./approval.js";
import type { Ordering } from "./registry.js";
import type { Approve, Tool } from "./types.js";

/**
 * How a mode uses the one tool set. A profile never takes a tool away: what a
 * session can run is decided by what it can reach.
 *
 * Chat talks it through: a spoken answer and a thread, short turns, history and
 * a workspace for context, and a question before each action that changes
 * something. Flow does it in place: it types where the user is or acts on the
 * screen, runs long, reads the app in front for context, and took its one
 * permission up front.
 */
export interface Profile<Host> extends Ordering {
  readonly name: "chat" | "flow";
  /** The API brain's system prompt. Each available tool adds its own lines. */
  prompt(tools: readonly Tool[], lang?: LanguageCode): string;
  /** The approval policy, built on what the session asks the user with. */
  approval(host: Host): Approve;
}

/** Asks the user a yes or no question; resolves true for a yes. */
export type Ask = (question: string, signal: AbortSignal) => Promise<boolean>;

export const CHAT: Profile<Ask> = {
  name: "chat",
  order: ["delegate", "update_todos", "remember", "look", "clipboard_read", "clipboard_write", "open_url", "list_dir", "read_file", "write_file", "edit_file"],
  prompt: (tools, lang) => withLanguage(buildLivePrompt(tools), lang),
  approval: askEach,
};

export const FLOW: Profile<ConsentOpts> = {
  name: "flow",
  order: ["insert_text", "read_selection", "clipboard_read", "clipboard_write", "get_context", "set_dictation"],
  prompt: (tools, lang) => buildFlowPrompt({ tools, lang }),
  approval: consentApprove,
};
