import { parsePartialJson } from "./partial-json.js";
import type { Approve, ImagePart, InsertionSink, Risk, TextPart, Tool, ToolCtx, ToolResult } from "./types.js";

// Tool plumbing for the Flow loop: repair what the model got wrong, validate,
// ask when the risk says to, run, and turn every possible failure into an
// ordinary tool result the model can read. Nothing here ever propagates.

const text = (t: string): TextPart => ({ type: "text", text: t });

export interface FlowToolCall { id: string; name: string; args: Record<string, unknown> }

export interface DispatchResult {
  id: string;
  name: string;
  content: (TextPart | ImagePart)[];
  details: unknown;
  isError: boolean;
  terminate: boolean;
}

// ── normalization ───────────────────────────────────────────────────────────

/** Compare names and keys the way models get them wrong: case, dashes, underscores. */
const reduce = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Semantic mistakes a reduce() match cannot catch. A repair is far cheaper than
// a round trip that tells the model to try again.
const NAME_ALIASES: Record<string, string> = {
  typetext: "insert_text",
  writetext: "insert_text",
  type: "insert_text",
  insert: "insert_text",
  getselection: "read_selection",
  selection: "read_selection",
  readclipboard: "clipboard_read",
  getclipboard: "clipboard_read",
  writeclipboard: "clipboard_write",
  setclipboard: "clipboard_write",
  copy: "clipboard_write",
  context: "get_context",
  getcontext: "get_context",
};

const WRAPPER_KEYS = ["input", "args", "arguments", "parameters", "params"];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function declaredKeys(tool: Tool): string[] {
  const props = isObj(tool.parameters) ? tool.parameters.properties : undefined;
  return isObj(props) ? Object.keys(props) : [];
}

function propSchema(tool: Tool, key: string): Record<string, unknown> {
  const props = isObj(tool.parameters) ? tool.parameters.properties : undefined;
  const p = isObj(props) ? props[key] : undefined;
  return isObj(p) ? p : {};
}

export function resolveToolName(name: string, tools: Tool[]): Tool | null {
  const exact = tools.find((t) => t.name === name);
  if (exact) return exact;
  const r = reduce(name);
  const alias = NAME_ALIASES[r];
  return tools.find((t) => reduce(t.name) === r) ?? (alias ? tools.find((t) => t.name === alias) ?? null : null);
}

/**
 * Repair a model's tool call, then prune it to the keys the tool declares.
 *
 * Whitelisting last is what makes the repairs safe: anything invented survives
 * only if it lands on a declared key.
 */
export function normalizeArgs(tool: Tool, raw: unknown): Record<string, unknown> {
  let args: Record<string, unknown> = isObj(raw) ? { ...raw } : typeof raw === "string" ? parsePartialJson(raw) : {};

  const keys = declaredKeys(tool);
  // `{"input": {...}}` from a model that wrapped its own arguments.
  if (!keys.some((k) => k in args)) {
    for (const w of WRAPPER_KEYS) {
      const inner = args[w];
      if (isObj(inner)) { args = { ...inner }; break; }
      if (typeof inner === "string") {
        const parsed = parsePartialJson(inner);
        if (Object.keys(parsed).length) { args = parsed; break; }
      }
    }
  }

  // Key spelling: `windowTitle` for `window_title`, `Text` for `text`.
  for (const k of Object.keys(args)) {
    if (keys.includes(k)) continue;
    const match = keys.find((d) => reduce(d) === reduce(k));
    if (match && !(match in args)) { args[match] = args[k]; delete args[k]; }
  }

  // The tool takes one string and the model named it something else
  // (`content`, `value`, `message` for `text`).
  const required = Array.isArray((tool.parameters as { required?: unknown }).required)
    ? ((tool.parameters as { required: unknown[] }).required.filter((k): k is string => typeof k === "string"))
    : [];
  if (required.length === 1 && !(required[0]! in args) && propSchema(tool, required[0]!).type === "string") {
    const loose = Object.entries(args).find(([, v]) => typeof v === "string");
    if (loose) { args[required[0]!] = loose[1]; delete args[loose[0]]; }
  }

  const pruned: Record<string, unknown> = {};
  for (const k of keys) if (k in args) pruned[k] = args[k];
  return pruned;
}

// ── validation ──────────────────────────────────────────────────────────────

// Models emit stringified numbers and booleans constantly. Coercing costs one
// comparison; rejecting costs a whole round trip.
function coerce(value: unknown, schema: Record<string, unknown>): { ok: true; value: unknown } | { ok: false; why: string } {
  const type = typeof schema.type === "string" ? schema.type : undefined;
  let v = value;
  if (type === "string" && (typeof v === "number" || typeof v === "boolean")) v = String(v);
  if ((type === "number" || type === "integer") && typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) v = Number(v);
  if (type === "boolean" && (v === "true" || v === "false")) v = v === "true";
  if (type === "array" && typeof v === "string") { const p: unknown = tryJson(v); if (Array.isArray(p)) v = p; }

  if (type === "string" && typeof v !== "string") return { ok: false, why: "expected a string" };
  if (type === "number" && typeof v !== "number") return { ok: false, why: "expected a number" };
  if (type === "integer" && (typeof v !== "number" || !Number.isInteger(v))) return { ok: false, why: "expected an integer" };
  if (type === "boolean" && typeof v !== "boolean") return { ok: false, why: "expected true or false" };
  if (type === "object" && !isObj(v)) return { ok: false, why: "expected an object" };
  if (type === "array") {
    if (!Array.isArray(v)) return { ok: false, why: "expected an array" };
    const item = isObj(schema.items) ? schema.items : null;
    if (item) {
      const out: unknown[] = [];
      for (const el of v) {
        const r = coerce(el, item);
        if (!r.ok) return r;
        out.push(r.value);
      }
      v = out;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(v)) return { ok: false, why: `expected one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}` };
  return { ok: true, value: v };
}

function tryJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return undefined; }
}

export function validateArgs(tool: Tool, args: Record<string, unknown>): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const out: Record<string, unknown> = {};
  for (const key of declaredKeys(tool)) {
    if (!(key in args) || args[key] === undefined || args[key] === null) continue;
    const r = coerce(args[key], propSchema(tool, key));
    if (!r.ok) return { ok: false, error: `Invalid "${key}": ${r.why}.` };
    out[key] = r.value;
  }
  const required = (tool.parameters as { required?: unknown }).required;
  if (Array.isArray(required)) {
    const missing = required.filter((k): k is string => typeof k === "string" && !(k in out));
    if (missing.length) return { ok: false, error: `Missing required ${missing.length > 1 ? "arguments" : "argument"}: ${missing.join(", ")}.` };
  }
  return { ok: true, value: out };
}

export const riskOf = (tool: Tool, args: unknown): Risk => (typeof tool.risk === "function" ? tool.risk(args) : tool.risk);

// ── dispatch ────────────────────────────────────────────────────────────────

interface Prepared {
  call: FlowToolCall;
  tool: Tool | null;
  args: Record<string, unknown>;
  error?: string;
}

const errResult = (call: FlowToolCall, msg: string): DispatchResult =>
  ({ id: call.id, name: call.name, content: [text(msg)], details: { error: msg }, isError: true, terminate: false });

function prepare(call: FlowToolCall, tools: Tool[]): Prepared {
  const tool = resolveToolName(call.name, tools);
  if (!tool) return { call, tool: null, args: {}, error: `Unknown tool "${call.name}". Available: ${tools.map((t) => t.name).join(", ")}.` };
  const normalized = normalizeArgs(tool, call.args);
  const valid = validateArgs(tool, normalized);
  if (!valid.ok) return { call, tool, args: normalized, error: valid.error };
  return { call, tool, args: valid.value };
}

/**
 * Run a batch of tool calls.
 *
 * Order is the whole point: normalize, validate, preflight SEQUENTIALLY so
 * approval prompts are serialised and deterministic, then execute in parallel.
 * Results are yielded in completion order for the UI; the returned array is in
 * assistant source order, which is the only order providers accept.
 */
export async function* dispatch(
  calls: FlowToolCall[],
  tools: Tool[],
  ctx: Omit<ToolCtx, "callId">,
  opts: { approve: Approve; parallel?: boolean },
): AsyncGenerator<DispatchResult, DispatchResult[]> {
  const prepared = calls.map((c) => prepare(c, tools));

  for (const p of prepared) {
    if (p.error || !p.tool) continue;
    if (ctx.signal.aborted) { p.error = "Cancelled before it ran."; continue; }
    const risk = riskOf(p.tool, p.args);
    try {
      const verdict = await opts.approve({ tool: p.tool, args: p.args, risk }, ctx.signal);
      if (verdict.block) p.error = `Blocked: ${verdict.reason}`;
    } catch (e) {
      p.error = `Blocked: ${errText(e)}`;
    }
  }

  const run = async (p: Prepared): Promise<DispatchResult> => {
    if (p.error || !p.tool) return errResult(p.call, p.error ?? "Tool unavailable.");
    if (ctx.signal.aborted) return errResult(p.call, "Cancelled before it ran.");
    try {
      const r: ToolResult = await p.tool.execute(p.args, { ...ctx, callId: p.call.id });
      return { id: p.call.id, name: p.tool.name, content: r.content, details: r.details, isError: false, terminate: !!r.terminate };
    } catch (e) {
      return errResult(p.call, errText(e));
    }
  };

  const results = new Array<DispatchResult>(prepared.length);
  if (opts.parallel === false) {
    for (let i = 0; i < prepared.length; i++) {
      const r = await run(prepared[i]!);
      results[i] = r;
      yield r;
    }
    return results;
  }

  const pending = new Map<number, Promise<{ i: number; r: DispatchResult }>>();
  prepared.forEach((p, i) => pending.set(i, run(p).then((r) => ({ i, r }))));
  while (pending.size) {
    const { i, r } = await Promise.race(pending.values());
    pending.delete(i);
    results[i] = r;
    yield r;
  }
  return results;
}

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return (m || "the tool failed").slice(0, 400);
}

// ── the Block 3 tool set ────────────────────────────────────────────────────

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
  constructor(private readonly push: (id: string, chunk: string) => Promise<void> | void, private readonly finish?: (id: string) => Promise<void> | void) {}

  async commit(id: string, textSoFar: string): Promise<void> {
    if (typeof textSoFar !== "string") return;
    const done = this.sent.get(id) ?? "";
    if (!textSoFar.startsWith(done) || textSoFar.length === done.length) return;
    this.sent.set(id, textSoFar);
    await this.push(id, textSoFar.slice(done.length));
  }

  async end(id: string): Promise<void> {
    if (!this.sent.has(id)) return;
    this.sent.delete(id);
    await this.finish?.(id);
  }

  /** How much of this call's text has already reached the user's app. */
  committed(id: string): string { return this.sent.get(id) ?? ""; }
}

const noParams = { type: "object", properties: {}, additionalProperties: false } as const;

const insertText: Tool<{ text: string }, { inserted: number }> = {
  name: "insert_text",
  description: "Type text into the app the user is in right now, at their cursor. Use this whenever they asked for words rather than an answer: a message, a commit message, a paragraph, a rewrite. Write only the text itself, no preamble and no quotes around it.",
  parameters: { type: "object", properties: { text: { type: "string", description: "Exactly the text to type, nothing else" } }, required: ["text"], additionalProperties: false },
  tier: "insert",
  risk: "safe",
  promptGuidelines: [
    "When they want words in their app, insert_text them; do not read them out as well.",
    "Text streams as you write it, so never restate or revise text you already wrote in the same call.",
  ],
  async execute(args, ctx) {
    await ctx.insert.commit(ctx.callId, args.text);
    await ctx.insert.end(ctx.callId);
    return { content: [text(`Typed ${args.text.length} characters.`)], details: { inserted: args.text.length } };
  },
};

const readSelection: Tool<Record<string, never>, { selection: string }> = {
  name: "read_selection",
  description: "Read the text the user currently has selected in the app they are in.",
  parameters: noParams,
  tier: "read",
  risk: "safe",
  async execute(_args, ctx) {
    const selection = ctx.context?.selection ?? "";
    return { content: [text(selection || "Nothing is selected right now.")], details: { selection } };
  },
};

const clipboardRead: Tool<Record<string, never>, { text: string }> = {
  name: "clipboard_read",
  description: "Read the text currently on the user's clipboard.",
  parameters: noParams,
  tier: "read",
  risk: "safe",
  async execute(_args, ctx) {
    const value = await ctx.clipboard.read();
    return { content: [text(value || "The clipboard is empty.")], details: { text: value } };
  },
};

const clipboardWrite: Tool<{ text: string }, { text: string }> = {
  name: "clipboard_write",
  description: "Put text on the user's clipboard so they can paste it themselves. Prefer insert_text when they want it typed where they are.",
  parameters: { type: "object", properties: { text: { type: "string", description: "The text to copy" } }, required: ["text"], additionalProperties: false },
  tier: "insert",
  risk: "safe",
  async execute(args, ctx) {
    await ctx.clipboard.write(args.text);
    return { content: [text("Copied.")], details: { text: args.text } };
  },
};

const getContext: Tool<Record<string, never>, { context: unknown }> = {
  name: "get_context",
  description: "What the user is looking at: the foreground app, its window title, any selected text, and the page URL when it is a browser.",
  parameters: noParams,
  tier: "read",
  risk: "safe",
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

/** Every tool Flow has in Block 3. Device control is Block 4 and is not stubbed here. */
export function flowTools(): Tool[] {
  return [insertText, readSelection, clipboardRead, clipboardWrite, getContext];
}

export const toolSpecs = (tools: Tool[]) => tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
