import type { InsertionSink, TextPart, Tool } from "./types.js";

// Words in and out of the app the user is in: typing at their cursor, what they
// have selected, what the app is, and the clipboard.

const text = (t: string): TextPart => ({ type: "text", text: t });

/**
 * Forward-only insertion, in one place.
 *
 * `commit` is given the whole text known so far and emits only the growth, so
 * the streaming path and the tool's own final call are the same operation seen
 * twice. Text that diverges from what was already sent is dropped rather than
 * retyped: those characters are already in the user's document.
 */
export class ForwardOnlyInsertion implements InsertionSink {
  private sent = new Map<string, string>();
  /** What an abandoned call left in the document, waiting for the retry that continues it. */
  private carried = "";
  constructor(private readonly push: (id: string, chunk: string) => Promise<void> | void, private readonly finish?: (id: string) => Promise<void> | void) {}

  async commit(id: string, textSoFar: string): Promise<void> {
    if (typeof textSoFar !== "string") return;
    const done = this.sent.get(id) ?? (textSoFar.startsWith(this.carried) ? this.carried : "");
    if (!textSoFar.startsWith(done) || textSoFar.length === done.length) return;
    this.carried = "";
    this.sent.set(id, textSoFar);
    await this.push(id, textSoFar.slice(done.length));
  }

  async end(id: string): Promise<void> {
    if (!this.sent.has(id)) return;
    this.sent.delete(id);
    await this.finish?.(id);
  }

  async abandon(id: string): Promise<void> {
    this.carried = this.sent.get(id) ?? "";
    await this.end(id);
  }

  /** How much of this call's text has already reached the user's app. */
  committed(id: string): string { return this.sent.get(id) ?? ""; }
}

export const noParams = { type: "object", properties: {}, additionalProperties: false } as const;

const insertText: Tool<{ text: string }, { inserted: number }> = {
  name: "insert_text",
  group: "text",
  description: "Type text into the app the user is in right now, at their cursor. Use this whenever they asked for words rather than an answer: a message, a commit message, a paragraph, a rewrite. Write only the text itself, no preamble and no quotes around it.",
  parameters: { type: "object", properties: { text: { type: "string", description: "Exactly the text to type, nothing else" } }, required: ["text"], additionalProperties: false },
  promptGuidelines: [
    "When they want words in their app, insert_text them; do not read them out as well.",
    "Text streams as you write it, so never restate or revise text you already wrote in the same call.",
  ],
  available: (s) => !!s.insert,
  async execute(args, ctx) {
    await ctx.insert!.commit(ctx.callId, args.text);
    await ctx.insert!.end(ctx.callId);
    return { content: [text(`Typed ${args.text.length} characters.`)], details: { inserted: args.text.length } };
  },
};

const readSelection: Tool<Record<string, never>, { selection: string }> = {
  name: "read_selection",
  group: "text",
  description: "Read the text the user currently has selected in the app they are in.",
  parameters: noParams,
  readOnly: true,
  available: (s) => !!s.foreground,
  async execute(_args, ctx) {
    const selection = ctx.context?.selection;
    if (selection === undefined) {
      return { content: [text("I cannot read the selection in this app, so I do not know whether anything is selected.")], details: { selection: "" } };
    }
    return { content: [text(selection || "Nothing is selected right now.")], details: { selection } };
  },
};

const clipboardRead: Tool<Record<string, never>, { text: string }> = {
  name: "clipboard_read",
  group: "text",
  description: "Read the text currently on the user's clipboard: what they just copied.",
  parameters: noParams,
  readOnly: true,
  available: (s) => !!s.clipboard,
  async execute(_args, ctx) {
    const value = await ctx.clipboard!.read();
    return { content: [text(value || "The clipboard is empty.")], details: { text: value } };
  },
};

const clipboardWrite: Tool<{ text: string }, { text: string }> = {
  name: "clipboard_write",
  group: "text",
  description: "Put text on the user's clipboard so they can paste it themselves. Prefer insert_text when they want it typed where they are.",
  parameters: { type: "object", properties: { text: { type: "string", description: "The text to copy" } }, required: ["text"], additionalProperties: false },
  available: (s) => !!s.clipboard,
  async execute(args, ctx) {
    const said = await ctx.clipboard!.write(args.text);
    return { content: [text(said || "Copied.")], details: { text: args.text } };
  },
};

const getContext: Tool<Record<string, never>, { context: unknown }> = {
  name: "get_context",
  group: "text",
  description: "What the user is looking at: the foreground app, its window title, any selected text, and the page URL when it is a browser.",
  parameters: noParams,
  readOnly: true,
  available: (s) => !!s.foreground,
  async execute(_args, ctx) {
    const c = ctx.context;
    if (!c) return { content: [text("I cannot see what app they are in right now.")], details: { context: null } };
    const lines = [
      c.app ? `App: ${c.app}` : "",
      c.windowTitle ? `Window: ${c.windowTitle}` : "",
      c.url ? `URL: ${c.url}` : "",
      c.selection ? `Selection: ${c.selection}` : "",
    ].filter(Boolean);
    return { content: [text(lines.join("\n") || "No details available.")], details: { context: c } };
  },
};

const setDictation: Tool<{ on: boolean }, { on: boolean }> = {
  name: "set_dictation",
  group: "text",
  description: "Turn hands-free dictation on or off. While it is on, what the user says is cleaned up and typed at their cursor instead of coming to you. Use it when they ask to start or stop dictating.",
  parameters: { type: "object", properties: { on: { type: "boolean", description: "true to start dictating, false to stop" } }, required: ["on"], additionalProperties: false },
  promptGuidelines: ["After set_dictation turns it on, answer in a few words: what they say next is typed, not sent to you."],
  available: (s) => !!s.dictate,
  async execute(args, ctx) {
    return { content: [text(await ctx.dictate!(args.on === true))], details: { on: args.on === true } };
  },
};

export const TEXT_TOOLS: Tool[] = [insertText, readSelection, clipboardRead, clipboardWrite, getContext, setDictation];
