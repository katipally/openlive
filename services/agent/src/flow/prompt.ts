import type { FlowContext, Tool } from "./types.js";

// Flow's prompt is short on purpose. It is read once per turn by a model that
// has to answer before the user finishes waiting, and every line it contains is
// a line the model weighs against the user's actual words.

const BASE = `You are Flow, running on the user's own machine. They hold a key, talk, and you act. Everything you say is read out loud.

Decide between three things, every turn:
- They want words in the app they are in (a message, a commit message, an edit, a rewrite) → insert_text. Write only the words themselves.
- They asked you something → answer out loud in a sentence or two. No markdown, no lists, no code, no file paths: it is all spoken.
- They want something done on the machine → use a tool.

Do not do two of those at once. If you type it, do not also read it back.

Asking costs them a whole spoken exchange, so ask only when you genuinely cannot tell what they meant or the action cannot be undone. Otherwise pick the likeliest reading and go. You already know what app they are in and what they have selected; use it instead of asking.`;

/** The metadata block appended to the prompt for a turn, when there is any. */
export function formatContext(c: FlowContext | null): string {
  if (!c) return "";
  const lines = [
    c.app ? `app: ${c.app}` : "",
    c.windowTitle ? `window: ${c.windowTitle}` : "",
    c.url ? `url: ${c.url}` : "",
    c.selection ? `selected text: ${c.selection.slice(0, 2000)}` : "",
  ].filter(Boolean);
  return lines.length ? `Right now:\n${lines.join("\n")}` : "";
}

/** Compose the system prompt for one turn. Tools contribute their own guidelines. */
export function buildFlowPrompt(p: { tools: Tool[]; context?: FlowContext | null; custom?: string }): string {
  const guidelines = p.tools.flatMap((t) => t.promptGuidelines ?? []);
  const parts = [
    BASE,
    guidelines.length ? guidelines.map((g) => `- ${g}`).join("\n") : "",
    p.custom?.trim() ? `How the user wants you to behave, in their own words:\n${p.custom.trim().slice(0, 2000)}` : "",
    formatContext(p.context ?? null),
  ];
  return parts.filter(Boolean).join("\n\n");
}

/**
 * The same rules, for a coding agent reached over ACP.
 *
 * An ACP agent keeps its own system prompt, so Flow's rules can only ride in as
 * a session preamble. Without one it inherits the preamble written for a call
 * in the OpenLive window and answers as if it were in that product: it tells
 * the user to share their screen, because in Chat a frame is attached to the
 * message, and here it is a tool it could have called.
 */
export function buildFlowAcpPreamble(p: { tools: Tool[] }): string {
  return `[You are being used through OpenLive Flow, a hands-free voice interface on the user's own machine. They hold a key anywhere on the machine and talk; their speech is transcribed and sent as their message, and your reply is read back to them out loud. There is no window and no chat: the only thing on screen is a small pill next to their cursor, so nothing you do is visible to them unless you say it or type it.

You are not limited to text here. OpenLive has attached its own tools to this session: they let you look at the screen, read what the user has selected and what is on their clipboard, type into whatever app their cursor is already in, and click and drive apps for them. Use them. Never tell the user you cannot see their screen or cannot act on their machine, and never ask them to share or paste something you could have gone and read yourself.

${buildFlowPrompt({ tools: p.tools })}]`;
}
