import { parsePartialJson } from "../flow/partial-json.js";
import { closeMatches, FIND_TOOLS, READ_TOOL, unwrapUse, USE_TOOL } from "./on-demand.js";
import type { Approve, ImagePart, TextPart, Tool, ToolCtx, ToolResult } from "./types.js";

// Tool plumbing for every loop and the MCP server: repair what the model got
// wrong, validate, check the person agreed, run, and turn every possible
// failure into an ordinary tool result the model can read. Nothing here ever
// propagates.

const text = (t: string): TextPart => ({ type: "text", text: t });

export interface ToolCall { id: string; name: string; args: Record<string, unknown> }

export interface DispatchResult {
  id: string;
  name: string;
  content: (TextPart | ImagePart)[];
  /** See ToolResult.state. */
  state?: (TextPart | ImagePart)[];
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
  // Device actions, under the names models reach for first.
  leftclick: "click",
  mouseclick: "click",
  tap: "click",
  contextclick: "right_click",
  mousemove: "move",
  movemouse: "move",
  movecursor: "move",
  takescreenshot: "screenshot",
  capturescreen: "screenshot",
  screencapture: "screenshot",
  ocr: "read_screen_text",
  readtext: "read_screen_text",
  readscreen: "read_screen_text",
  windows: "list_windows",
  activatewindow: "window_activate",
  focuswindow: "window_activate",
  movewindow: "window_move",
  resizewindow: "window_resize",
  minimizewindow: "window_minimize",
  closewindow: "window_close",
  launchapp: "open_app",
  openapplication: "open_app",
  openbrowser: "open_url",
  presskey: "keypress",
  key: "keypress",
  hotkey: "keypress",
  typetextraw: "type",
  runcommand: "shell",
  bash: "shell",
  exec: "shell",
  terminal: "shell",
};

// `coordinate: [x, y]` is the single most common hallucinated shape, because
// that is what the published computer-use schemas look like.
const POINT_KEYS = ["coordinate", "coordinates", "position", "point", "coords", "location"];

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

/**
 * The tools one session was given, looked up the way models get names wrong.
 * Built once per session; every lookup is O(1).
 */
export class ToolSet {
  private readonly exact = new Map<string, Tool>();
  private readonly loose = new Map<string, Tool>();
  /** The connector tools held back for use_tool, when this session loads them on demand. */
  readonly onDemand: ToolSet | null;

  constructor(readonly list: readonly Tool[], held: readonly Tool[] = []) {
    for (const t of list) {
      this.exact.set(t.name, t);
      const r = reduce(t.name);
      if (!this.loose.has(r)) this.loose.set(r, t);
    }
    this.onDemand = held.length ? new ToolSet(held) : null;
  }

  resolve(name: string): Tool | null {
    const r = reduce(name);
    const alias = Object.hasOwn(NAME_ALIASES, r) ? NAME_ALIASES[r]! : "";
    return this.exact.get(name) ?? this.loose.get(r) ?? this.exact.get(alias) ?? null;
  }
}

/** What a set offers a model, as one string: two sets that read the same are the same offer. O(total schema size). */
export const offerOf = (s: ToolSet): string =>
  JSON.stringify([s.list, s.onDemand?.list ?? []].map((l) => l.map((t) => [t.name, t.description, t.parameters, !!t.confirm, !!t.readOnly])));

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

  // A point given as a pair, for a tool that wants two numbers.
  if (keys.includes("x") && keys.includes("y") && !("x" in args)) {
    for (const k of POINT_KEYS) {
      const pair = args[k];
      if (Array.isArray(pair) && pair.length >= 2) { args.x = pair[0]; args.y = pair[1]; break; }
      if (isObj(pair) && "x" in pair && "y" in pair) { args.x = pair.x; args.y = pair.y; break; }
    }
  }

  // Key spelling: `windowTitle` for `window_title`, `Text` for `text`.
  for (const k of Object.keys(args)) {
    if (keys.includes(k)) continue;
    const match = keys.find((d) => reduce(d) === reduce(k));
    if (match && !(match in args)) { args[match] = args[k]; delete args[k]; }
  }

  // A chord written as "ctrl+c" where the tool wants ["ctrl", "c"]. A string
  // that is already JSON is left for the validator's own coercion.
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && propSchema(tool, k).type === "array" && !v.trimStart().startsWith("[")) {
      args[k] = v.split(/[+,\s]+/).filter(Boolean);
    }
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

/** An answered consent check. Kept by whoever asked first, so nobody is asked twice about one call. */
export type Verdict = Awaited<ReturnType<Approve>>;

/** Told of each dispatched call once it settles: the tool it resolved to (null when none) and whether it failed. */
export type ToolTally = (tool: string | null, failed: boolean) => void;

// ── dispatch ────────────────────────────────────────────────────────────────

interface Prepared {
  call: ToolCall;
  tool: Tool | null;
  args: Record<string, unknown>;
  error?: string;
}

const errResult = (call: ToolCall, msg: string): DispatchResult =>
  ({ id: call.id, name: call.name, content: [text(msg)], details: { error: msg }, isError: true, terminate: false });

/** A call as the tool it reaches: read_tool's and use_tool's become the held-back tool they name. */
function target(call: ToolCall, tools: ToolSet): { tool: Tool; raw: unknown } | { error: string } {
  const tool = tools.resolve(call.name);
  const held = tools.onDemand;
  if (tool && !(held && (tool.name === USE_TOOL || tool.name === READ_TOOL))) return { tool, raw: call.args };
  if (!held) return { error: `Unknown tool "${call.name}". Available: ${tools.list.map((t) => t.name).join(", ")}.` };
  if (!tool) {
    const named = held.resolve(call.name);
    return { error: named ? `${named.name} loads on demand: call ${named.readOnly ? READ_TOOL : USE_TOOL} with name "${named.name}" and its arguments.` : `Unknown tool "${call.name}". Available: ${tools.list.map((t) => t.name).join(", ")}. Connector tools are found with ${FIND_TOOLS}.` };
  }
  const use = unwrapUse(call.args);
  const real = held.resolve(use.name);
  if (real && tool.name === READ_TOOL && !real.readOnly) return { error: `${real.name} changes something, so ${READ_TOOL} does not run it. Call ${USE_TOOL} with the same name and arguments.` };
  if (real) return { tool: real, raw: use.args };
  const close = closeMatches(use.name, held.list);
  return { error: `No connector tool "${use.name}" is on in this session.${close.length ? ` Close: ${close.join(", ")}.` : ""} Search with ${FIND_TOOLS}.` };
}

/** The tool a call reaches, by name, for whatever shows or records it: read_tool's
 *  and use_tool's is the connector tool they run. The call's own name when it reaches none. */
export function shownName(call: ToolCall, tools: ToolSet): string {
  const t = target(call, tools);
  return "tool" in t ? t.tool.name : call.name;
}

function prepare(call: ToolCall, tools: ToolSet): Prepared {
  const t = target(call, tools);
  if ("error" in t) return { call, tool: null, args: {}, error: t.error };
  const { tool } = t;
  const normalized = normalizeArgs(tool, t.raw);
  const valid = validateArgs(tool, normalized);
  if (!valid.ok) return { call, tool, args: normalized, error: valid.error };
  return { call, tool, args: valid.value };
}

/**
 * Run a batch of tool calls.
 *
 * Order is the whole point: normalize, validate, precheck, preflight SEQUENTIALLY so a
 * first-run consent is taken once, not once per call, then execute in parallel.
 * Results are yielded in completion order for the UI; the returned array is in
 * assistant source order, which is the only order providers accept.
 *
 * A call whose approval was already answered elsewhere (the streaming insertion
 * path decides before it commits a character) carries its verdict in
 * `preflighted` and is not asked about twice.
 */
export async function* dispatch(
  calls: ToolCall[],
  tools: ToolSet,
  ctx: Omit<ToolCtx, "callId">,
  opts: { approve: Approve; parallel?: boolean; preflighted?: Map<string, Promise<Verdict>>; tally?: ToolTally },
): AsyncGenerator<DispatchResult, DispatchResult[]> {
  const prepared = calls.map((c) => prepare(c, tools));

  for (const p of prepared) {
    if (p.error || !p.tool) continue;
    if (ctx.signal.aborted) { p.error = "Cancelled before it ran."; continue; }
    try { await p.tool.precheck?.(p.args, { ...ctx, callId: p.call.id }); }
    catch (e) { p.error = errText(e); continue; }
    try {
      const already = opts.preflighted?.get(p.call.id);
      const verdict = await (already ?? opts.approve({ tool: p.tool, args: p.args }, ctx.signal));
      if (verdict.block) p.error = `Blocked: ${verdict.reason}`;
    } catch (e) {
      p.error = `Blocked: ${errText(e)}`;
    }
  }

  const execute = async (p: Prepared): Promise<DispatchResult> => {
    if (p.error || !p.tool) return errResult(p.call, p.error ?? "Tool unavailable.");
    if (ctx.signal.aborted) return errResult(p.call, "Cancelled before it ran.");
    try {
      const r: ToolResult = await p.tool.execute(p.args, { ...ctx, callId: p.call.id });
      return { id: p.call.id, name: p.tool.name, content: r.content, ...(r.state && { state: r.state }), details: r.details, isError: false, terminate: !!r.terminate };
    } catch (e) {
      return errResult(p.call, errText(e));
    }
  };

  // The one place a result is counted, whichever brain called: only a tool that
  // resolved is named, and a stopped turn's cancellations are not failures.
  const run = async (p: Prepared): Promise<DispatchResult> => {
    const r = await execute(p);
    opts.tally?.(p.tool?.name ?? null, r.isError && !ctx.signal.aborted);
    return r;
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

/** The whole batch at once, for a caller with nothing to show until it is done. */
export async function dispatchAll(...args: Parameters<typeof dispatch>): Promise<DispatchResult[]> {
  const running = dispatch(...args);
  let step = await running.next();
  while (!step.done) step = await running.next();
  return step.value;
}

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return (m || "the tool failed").slice(0, 400);
}

export const toolSpecs = (tools: readonly Tool[]) => tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

/** What the available tools add to a system prompt, one line each. */
export const toolGuidelines = (tools: readonly Tool[]): string =>
  tools.flatMap((t) => t.promptGuidelines ?? []).map((g) => `- ${g}`).join("\n");

const pictures = (parts: (TextPart | ImagePart)[]) => parts.filter((c) => c.type === "image").map((c) => ({ data: c.data, mime: c.mime }));
const words = (parts: (TextPart | ImagePart)[]) => parts.filter((c): c is TextPart => c.type === "text").map((c) => c.text).join("\n");

/** Fixed wording, so a stored result never changes once written. */
export const STATE_ELSEWHERE = "[The window state this left is not kept here. Only the newest one is, at the end of the conversation.]";

/** A result as one tool message reads it: the text, with the pictures beside it.
 *  Its window state stays out: see `asStateTail`. */
export function asMessage(r: DispatchResult): { callId: string; name: string; result: string; isError: boolean; images?: { data: string; mime: string }[] } {
  const images = pictures(r.content);
  const result = [words(r.content), r.state && STATE_ELSEWHERE].filter(Boolean).join("\n") || "(no output)";
  return { callId: r.id, name: r.name, result, isError: r.isError, ...(images.length && { images }) };
}

/** The newest window state, said once at the end of the next request and never stored. */
export interface StateTail { text: string; images?: { data: string; mime: string }[] }

/** Each transcript's newest window state, kept beside it and never in it, so no
 *  stored message is ever rewritten. Keyed by the array: a transcript that is
 *  replaced (a resumed or a new session) starts with none until the next action. */
export const newestState = new WeakMap<object, StateTail>();

export function asStateTail(tool: string, state: (TextPart | ImagePart)[]): StateTail {
  const images = pictures(state);
  return { text: `The newest window state, left by ${tool}. Element numbers and picture coordinates refer to this one:\n${words(state)}`, ...(images.length && { images }) };
}

/** Everything a call returned, its window state included, for whoever is not the model's transcript. */
export const allContent = (r: { content: (TextPart | ImagePart)[]; state?: (TextPart | ImagePart)[] }) => (r.state ? [...r.content, ...r.state] : r.content);
