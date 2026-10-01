import { getSetting, setSetting } from "@openlive/db";
import type { OnDemandMode } from "@openlive/shared";
import { firstSentence } from "./groups.js";
import type { TextPart, Tool } from "./types.js";

// Connector tools loaded on demand. With many connectors on, every request would
// carry hundreds of schemas: slow, costly, and models pick tools worse. Instead
// a session that holds them back gets three fixed tools, find_tools, read_tool
// and use_tool, whatever the brain. The tools array never changes within a
// session, so the prompt cache it heads stays whole; what a search finds arrives
// as a tool result, after the cached prefix. read_tool and use_tool are unwrapped
// by dispatch into the real tool's call, so validation, approval, the input lock
// and telemetry are the real tool's own. read_tool exists only to be marked
// read-only over MCP: Codex asks before any tool not so marked, and one wrapper
// for everything could never carry the mark.
//
// Not native tool search (Anthropic's defer_loading, OpenAI's tool_search): both
// need provider blocks our adapters and session files do not carry, and the
// Chat Completions path and local models have no equivalent, so one generic
// mechanism keeps every brain the same.

export const FIND_TOOLS = "find_tools";
export const USE_TOOL = "use_tool";
export const READ_TOOL = "read_tool";

/** settings.json key. */
const MODE_KEY = "connectorToolLoading";

export const onDemandMode = (): OnDemandMode => {
  const v = getSetting(MODE_KEY);
  return v === "on" || v === "off" ? v : "auto";
};

export const setOnDemandMode = (mode: OnDemandMode): Promise<void> => setSetting(MODE_KEY, mode);

/**
 * When `auto` holds connector tools back. Flow's own tools are 38 schemas, about
 * 5.2k tokens, and Chat's 14, about 1.6k. Past 40 more, a session offers around
 * 80 tools, well beyond the 30 to 50 where Anthropic measures tool choice
 * getting worse. 8k tokens catches the few servers with very large schemas:
 * more than Flow's whole tool prefix again, under Anthropic's own 10k advice.
 */
export const AUTO_THRESHOLD = { tools: 40, tokens: 8_000 } as const;

/** About four characters a token, over what a provider is sent. O(schema size). */
export const schemaTokens = (tools: readonly Tool[]): number =>
  Math.ceil(JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))).length / 4);

/** Whether these connector tools load on demand. Decided once, when a session's tool set is built. */
export const onDemandActive = (mode: OnDemandMode, tools: readonly Tool[]): boolean =>
  tools.length > 0 && (mode === "on" || (mode === "auto" && (tools.length > AUTO_THRESHOLD.tools || schemaTokens(tools) > AUTO_THRESHOLD.tokens)));

// ── ranking ─────────────────────────────────────────────────────────────────

const STOP = new Set(["the", "and", "for", "to", "in", "of", "on", "with", "my", "an", "a", "or", "it", "is"]);
const stem = (w: string) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w)).map(stem);
const reduce = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

interface Indexed { tool: Tool; name: Set<string>; text: Set<string> }

const paramNames = (t: Tool) => {
  const props = (t.parameters as { properties?: unknown }).properties;
  return props && typeof props === "object" ? Object.keys(props).join(" ") : "";
};

const index = (tools: readonly Tool[]): Indexed[] =>
  tools.map((tool) => ({ tool, name: new Set(words(`${tool.name} ${tool.connector ?? ""}`)), text: new Set(words(`${tool.description} ${paramNames(tool)}`)) }));

/**
 * Tools best matching a query: a word in the name or connector counts 3, in the
 * description or an argument's name 1, and the exact name wins outright. Ties
 * go by name, so the same query always gives the same list. O(T·q + T log T)
 * for T tools and q query words, over an index built once: O(total text).
 */
function rank(query: string, idx: readonly Indexed[], limit: number): Tool[] {
  const q = [...new Set(words(query))];
  const exact = reduce(query);
  return idx
    .map((e) => ({ t: e.tool, s: (reduce(e.tool.name) === exact ? 1000 : 0) + q.reduce((n, w) => n + (e.name.has(w) ? 3 : e.text.has(w) ? 1 : 0), 0) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.t.name.localeCompare(b.t.name))
    .slice(0, limit)
    .map((x) => x.t);
}

/** Names close to one the model got wrong, for its error. */
export const closeMatches = (name: string, tools: readonly Tool[]): string[] =>
  rank(name.replace(/__/g, " "), index(tools), 5).map((t) => t.name);

// ── the two tools ───────────────────────────────────────────────────────────

/** About 2k tokens for the catalog in find_tools' description. */
const CATALOG_MAX = 8_000;
const LINE_MAX = 300;

/** A connector tool's description without the "(Connector)" its individual form ends with. */
const own = (t: Tool) => {
  const tail = ` (${t.connector})`;
  return t.description.endsWith(tail) ? t.description.slice(0, -tail.length) : t.description;
};

const byConnector = (tools: readonly Tool[]) => {
  const out = new Map<string, Tool[]>();
  for (const t of tools) {
    const list = out.get(t.connector ?? "");
    if (list) list.push(t); else out.set(t.connector ?? "", [t]);
  }
  return [...out];
};

/**
 * Every held-back tool, one line each under its connector, or, past the
 * budget, names only. A catalog bigger than even that ends with how many it
 * left out, which a search still reaches. O(T).
 */
function catalog(tools: readonly Tool[]): string {
  const groups = byConnector(tools);
  const full = groups.map(([c, ts]) => `${c}:\n${ts.map((t) => `- ${t.name}: ${firstSentence(own(t))}`).join("\n")}`).join("\n");
  if (full.length <= CATALOG_MAX) return full;
  const lines: string[] = [];
  let used = 0;
  let shown = 0;
  for (const [c, ts] of groups) {
    const line = `${c}: ${ts.map((t) => t.name).join(", ")}`;
    if (used + line.length > CATALOG_MAX) break;
    lines.push(line);
    used += line.length + 1;
    shown += ts.length;
  }
  return [...lines, ...(shown < tools.length ? [`[${tools.length - shown} more tools not listed here. Search finds them.]`] : [])].join("\n");
}

const text = (t: string): TextPart => ({ type: "text", text: t });
const oneLine = (s: string) => { const flat = s.replace(/\s+/g, " ").trim(); return flat.length > LINE_MAX ? `${flat.slice(0, LINE_MAX - 1)}…` : flat; };

function findTools(held: readonly Tool[]): Tool<{ query: string; limit?: number }, { found: string[] }> {
  const idx = index(held);
  return {
    name: FIND_TOOLS,
    description: `Find a connector tool by what it does. Connector tools are not offered as tools of their own here: search with a few words of the task, a connector's name or a tool's exact name, then run what you found with the tool its result names: ${READ_TOOL} for one that only reads, ${USE_TOOL} for the rest. Each result comes with its arguments' JSON schema.\n\n<connector_tools>\n${catalog(held)}\n</connector_tools>`,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words for what the tool does, a connector's name, or a tool's name." },
        limit: { type: "integer", description: "How many tools to return, 1 to 20. Defaults to 5." },
      },
      required: ["query"],
    },
    readOnly: true,
    async execute({ query, limit }) {
      const found = rank(query, idx, Math.min(20, Math.max(1, limit ?? 5)));
      if (!found.length) return { content: [text(`No connector tool matched "${query}". Try other words, or a name from the list in ${FIND_TOOLS}'s description.`)], details: { found: [] } };
      const body = found.map((t) => `${t.name} (${t.connector}${t.confirm ? ", asks the user first" : ""}; run with ${t.readOnly ? READ_TOOL : USE_TOOL}): ${oneLine(own(t))}\nArguments: ${JSON.stringify(t.parameters)}`).join("\n\n");
      return { content: [text(`${body}\n\nRun one with the tool named beside it: {"name": "<tool name>", "arguments": {...}}.`)], details: { found: found.map((t) => t.name) } };
    },
  };
}

const wrapper = (name: string, description: string, readOnly = false): Tool => ({
  name,
  description,
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: `The tool's full name, as ${FIND_TOOLS} gives it.` },
      arguments: { type: "object", description: "The tool's own arguments." },
    },
    required: ["name"],
  },
  ...(readOnly && { readOnly }),
  // Dispatch runs the real tool in its place, so this only answers a session with nothing held back.
  async execute() { throw new Error("No connector tools load on demand in this session."); },
});

const readTool = wrapper(READ_TOOL, `Run a connector tool that only reads, as ${FIND_TOOLS} marks it: its full name, and arguments matching the schema ${FIND_TOOLS} gave. A tool that changes something is refused here: run that one with ${USE_TOOL}.`, true);

const useTool = wrapper(USE_TOOL, `Run any connector tool that ${FIND_TOOLS} showed you: its full name, and arguments matching the schema ${FIND_TOOLS} gave. It asks the user first whenever that tool would.`);

/** The tools a session gets in place of the connector tools it holds back. */
export const onDemandTools = (held: readonly Tool[]): Tool[] => [findTools(held), readTool, useTool];

/** read_tool's or use_tool's arguments as the real call: the name, and its arguments wherever the model put them. */
export function unwrapUse(args: Record<string, unknown>): { name: string; args: unknown } {
  const { name, tool, arguments: inner, ...rest } = args;
  const n = typeof name === "string" ? name : typeof tool === "string" ? tool : "";
  return { name: n, args: inner ?? rest };
}
