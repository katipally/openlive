import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CachedTool, ConnectorRow } from "@openlive/db";
import type { Approve, Tool } from "./types.js";
import type { Brain, Msg, TurnRequest } from "../flow/types.js";

// Its own home: the mode set here must not reach another file's sessions.
const dir = mkdtempSync(join(tmpdir(), "ol-on-demand-"));
process.env.OPENLIVE_HOME = dir;
const { AUTO_THRESHOLD, FIND_TOOLS, onDemandActive, onDemandMode, READ_TOOL, setOnDemandMode, USE_TOOL } = await import("./on-demand.js");
const { ToolRegistry, registry: shared } = await import("./registry.js");
const { dispatchAll, toolSpecs } = await import("./dispatch.js");
const { askEach } = await import("./approval.js");
const { mcpServer } = await import("./mcp.js");
const { CHAT, FLOW } = await import("./profiles.js");
const { connectorTool } = await import("../connectors/tools.js");
const { runFlow } = await import("../flow/loop.js");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SERVICES = ["Notion", "Linear", "Slack", "GitHub", "Drive", "Calendar", "Gmail", "Figma", "Jira", "Sentry"];
const calls: { tool: string; args: unknown }[] = [];
const manager = { call: async (_id: string, tool: string, args: unknown) => { calls.push({ tool, args }); return { content: [{ type: "text", text: `${tool} done` }] }; } } as never;

/** A connector's tool, built the way the real provider builds it. Even ones only read. */
function fixture(i: number): Tool {
  const service = SERVICES[i % SERVICES.length]!;
  const row = { id: `c${i % SERVICES.length}`, name: service, slug: service.toLowerCase(), trustReadOnly: true } as ConnectorRow;
  const cached: CachedTool = {
    name: `action_${i}`,
    description: `Does action ${i} in ${service}. Takes an id and a note.`,
    inputSchema: { properties: { id: { type: "string", description: "The item's id." }, note: { type: "string", description: "Free text." }, count: { type: "integer" } }, required: ["id"] },
    readOnly: i % 2 === 0,
  } as CachedTool;
  return connectorTool(row, cached, `${row.slug}__action_${i}`, manager);
}

const create = connectorTool({ id: "n", name: "Notion", slug: "notion", trustReadOnly: true } as ConnectorRow, {
  name: "create_page", description: "Create a page in a Notion workspace.", inputSchema: { properties: { title: { type: "string" } }, required: ["title"] }, readOnly: false,
} as CachedTool, "notion__create_page", manager);
const search = connectorTool({ id: "n", name: "Notion", slug: "notion", trustReadOnly: true } as ConnectorRow, {
  name: "search", description: "Search pages and databases.", inputSchema: { properties: { query: { type: "string" } }, required: ["query"] }, readOnly: true,
} as CachedTool, "notion__search", manager);

const TOOLS = [create, search, ...Array.from({ length: 198 }, (_, i) => fixture(i))];

/** A registry with OpenLive's own tools and 200 connector tools. */
function withConnectors(tools: Tool[] = TOOLS) {
  const r = new ToolRegistry();
  r.register((s) => shared.tools(CHAT, s, "off").list as Tool[]);
  r.register(() => tools);
  return r;
}

const session = { clipboard: { read: async () => "", write: async () => {} }, workspace: () => dir };
const ctx = () => ({ signal: new AbortController().signal, context: null, ...session });
const call = (name: string, args: Record<string, unknown>, id = "c1") => ({ id, name, args });
const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("\n");

describe("the mode", () => {
  it("is auto until set, and reads back what was set", async () => {
    expect(onDemandMode()).toBe("auto");
    await setOnDemandMode("off");
    expect(onDemandMode()).toBe("off");
    await setOnDemandMode("auto");
  });

  it("auto turns on past the tool count or the token budget, never for none", () => {
    const small = (n: number) => TOOLS.slice(0, n);
    expect(onDemandActive("auto", small(AUTO_THRESHOLD.tools))).toBe(false);
    expect(onDemandActive("auto", small(AUTO_THRESHOLD.tools + 1))).toBe(true);
    const fat = { ...search, parameters: { type: "object", properties: { q: { type: "string", description: "x".repeat(AUTO_THRESHOLD.tokens * 4) } } } };
    expect(onDemandActive("auto", [fat])).toBe(true);
    expect(onDemandActive("on", [search])).toBe(true);
    expect(onDemandActive("off", TOOLS)).toBe(false);
    expect(onDemandActive("on", [])).toBe(false);
  });

  it("is fixed for the session: a set built before the switch keeps its tools", async () => {
    const r = withConnectors();
    const before = r.tools(CHAT, session);
    const specs = JSON.stringify(toolSpecs(before.list));
    expect(before.list.map((t) => t.name)).toEqual(expect.arrayContaining([FIND_TOOLS, READ_TOOL, USE_TOOL]));
    expect(before.list.some((t) => t.connector)).toBe(false);
    await setOnDemandMode("off");
    try {
      expect(JSON.stringify(toolSpecs(before.list))).toBe(specs);
      expect(before.onDemand?.list).toHaveLength(200);
      const next = r.tools(CHAT, session);
      expect(next.list.filter((t) => t.connector)).toHaveLength(200);
      expect(next.onDemand).toBeNull();
    } finally { await setOnDemandMode("auto"); }
  });

  it("keeps OpenLive's own tools as real tools", () => {
    const own = shared.tools(CHAT, session, "off").list.map((t) => t.name);
    const set = withConnectors().tools(CHAT, session, "on");
    expect(set.list.map((t) => t.name)).toEqual([...own, FIND_TOOLS, READ_TOOL, USE_TOOL]);
  });
});

describe("the tools array within a session", () => {
  it("is byte-identical on every step, through find_tools, use_tool and read_tool", async () => {
    const tools = withConnectors().tools(FLOW, session, "auto");
    const seen: string[] = [];
    const turns = [
      [{ type: "tool_start", id: "a", name: FIND_TOOLS }, { type: "tool_end", id: "a", name: FIND_TOOLS, args: { query: "create a notion page" } }, { type: "turn_done", stop: "tools" }],
      [{ type: "tool_start", id: "b", name: USE_TOOL }, { type: "tool_end", id: "b", name: USE_TOOL, args: { name: "notion__create_page", arguments: { title: "Plan" } } }, { type: "turn_done", stop: "tools" }],
      [{ type: "tool_start", id: "c", name: READ_TOOL }, { type: "tool_end", id: "c", name: READ_TOOL, args: { name: "notion__search", arguments: { query: "plan" } } }, { type: "turn_done", stop: "tools" }],
      [{ type: "text_delta", delta: "Done." }, { type: "turn_done", stop: "stop" }],
    ];
    let turn = 0;
    const brain = {
      id: "scripted",
      async *stream(req: TurnRequest) { seen.push(JSON.stringify(req.tools)); yield* turns[turn++]!; },
    } as unknown as Brain;
    const results: string[] = [], named: string[] = [];
    const messages: Msg[] = [{ role: "user", text: "make a page" }];
    for await (const e of runFlow({ brain, tools, messages, signal: new AbortController().signal, session, getSystemPrompt: () => "system" })) {
      if (e.type === "tool_result") results.push(`${e.name}: ${textOf(e)}`);
      if (e.type === "tool_start" || e.type === "tool_call") named.push(`${e.type} ${e.name}`);
    }
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(1);
    expect(results[0]).toContain("notion__create_page (Notion, asks the user first; run with use_tool)");
    expect(results[0]).toContain("notion__search (Notion; run with read_tool)");
    expect(results.slice(1)).toEqual(["notion__create_page: create_page done", "notion__search: search done"]);
    // The orb and the session file name the tool that ran; the model's own transcript keeps the call it made.
    expect(named).toEqual([
      `tool_start ${FIND_TOOLS}`, `tool_call ${FIND_TOOLS}`,
      "tool_start notion__create_page", "tool_call notion__create_page",
      "tool_start notion__search", "tool_call notion__search",
    ]);
    expect(messages.flatMap((m) => (m.role === "assistant" ? m.toolCalls?.map((c) => c.name) ?? [] : []))).toEqual([FIND_TOOLS, USE_TOOL, READ_TOOL]);

    // What a 200-tool fixture costs every request, both ways.
    const all = JSON.stringify(toolSpecs(withConnectors().tools(FLOW, session, "off").list)).length;
    expect(seen[0]!.length).toBeLessThan(all / 3);
  });
});

describe("use_tool", () => {
  const set = () => withConnectors().tools(CHAT, session, "on");
  const asked: string[] = [];
  const approve = (yes: boolean): Approve => askEach(async (q) => { asked.push(q); return yes; });

  it("asks in the real tool's words, and runs it on a yes", async () => {
    asked.length = 0; calls.length = 0;
    const tallied: (string | null)[] = [];
    const [r] = await dispatchAll([call(USE_TOOL, { name: "notion__create_page", arguments: { title: "Plan" } })], set(), ctx(), { approve: approve(true), tally: (t) => tallied.push(t) });
    expect(asked).toEqual(["OpenLive wants to use Notion: create_page. Allow it?"]);
    expect(r).toMatchObject({ name: "notion__create_page", isError: false });
    expect(calls).toEqual([{ tool: "create_page", args: { title: "Plan" } }]);
    expect(tallied).toEqual(["notion__create_page"]);
  });

  it("blocks on a no, and runs a read-only tool without asking", async () => {
    asked.length = 0; calls.length = 0;
    const [no] = await dispatchAll([call(USE_TOOL, { name: "notion__create_page", arguments: { title: "Plan" } })], set(), ctx(), { approve: approve(false) });
    expect(no!.isError).toBe(true);
    expect(textOf(no!)).toContain("Blocked");
    const [read] = await dispatchAll([call(USE_TOOL, { name: "notion__search", arguments: { query: "x" } })], set(), ctx(), { approve: approve(false) });
    expect(read!.isError).toBe(false);
    expect(asked).toHaveLength(1);
    expect(calls).toEqual([{ tool: "search", args: { query: "x" } }]);
  });

  it("repairs the call as a direct one would: stringified and loose arguments", async () => {
    calls.length = 0;
    await dispatchAll([call(USE_TOOL, { name: "notion__search", arguments: JSON.stringify({ query: "a" }) })], set(), ctx(), { approve: approve(true) });
    await dispatchAll([call(USE_TOOL, { name: "notion__search", query: "b" })], set(), ctx(), { approve: approve(true) });
    expect(calls.map((c) => c.args)).toEqual([{ query: "a" }, { query: "b" }]);
  });

  it("returns schema errors to the model", async () => {
    const [r] = await dispatchAll([call(USE_TOOL, { name: "notion__create_page", arguments: {} })], set(), ctx(), { approve: approve(true) });
    expect(r!.isError).toBe(true);
    expect(textOf(r!)).toBe("Missing required argument: title.");
  });

  it("reaches only the tools on for this session, and names close ones", async () => {
    const off = withConnectors(TOOLS.filter((t) => t.name !== "notion__create_page")).tools(CHAT, session, "on");
    const [r] = await dispatchAll([call(USE_TOOL, { name: "notion__create_page", arguments: { title: "x" } })], off, ctx(), { approve: approve(true) });
    expect(r!.isError).toBe(true);
    expect(textOf(r!)).toMatch(/^No connector tool "notion__create_page" is on in this session\. Close: notion__search, notion__action_0, /);
  });

  it("points a direct call of a held-back tool at read_tool or use_tool, as it only reads or not", async () => {
    const [read] = await dispatchAll([call("notion__search", { query: "x" })], set(), ctx(), { approve: approve(true) });
    expect(textOf(read!)).toBe(`notion__search loads on demand: call ${READ_TOOL} with name "notion__search" and its arguments.`);
    const [act] = await dispatchAll([call("notion__create_page", { title: "x" })], set(), ctx(), { approve: approve(true) });
    expect(textOf(act!)).toBe(`notion__create_page loads on demand: call ${USE_TOOL} with name "notion__create_page" and its arguments.`);
  });
});

describe("read_tool", () => {
  const set = () => withConnectors().tools(CHAT, session, "on");

  it("runs a tool that only reads, as that tool, without asking", async () => {
    calls.length = 0;
    const asked: string[] = [];
    const [r] = await dispatchAll([call(READ_TOOL, { name: "notion__search", arguments: { query: "x" } })], set(), ctx(), { approve: askEach(async (q) => { asked.push(q); return false; }) });
    expect(r).toMatchObject({ name: "notion__search", isError: false });
    expect(asked).toEqual([]);
    expect(calls).toEqual([{ tool: "search", args: { query: "x" } }]);
  });

  it("refuses a tool that changes something, pointing at use_tool, and runs nothing", async () => {
    calls.length = 0;
    const [r] = await dispatchAll([call(READ_TOOL, { name: "notion__create_page", arguments: { title: "Plan" } })], set(), ctx(), { approve: askEach(async () => true) });
    expect(r!.isError).toBe(true);
    expect(textOf(r!)).toBe(`notion__create_page changes something, so ${READ_TOOL} does not run it. Call ${USE_TOOL} with the same name and arguments.`);
    expect(calls).toEqual([]);
  });
});

describe("find_tools", () => {
  const find = (tools: Tool[] = TOOLS) => withConnectors(tools).tools(CHAT, session, "on").resolve(FIND_TOOLS)!;
  const names = async (query: string, limit?: number) =>
    ((await find().execute({ query, limit }, { ...ctx(), callId: "f" })).details as { found: string[] }).found;

  it("ranks name words over description words, the same way every time", async () => {
    // "page" is in create_page's name and only in search's description.
    expect(await names("create page")).toEqual(["notion__create_page", "notion__search"]);
    expect((await names("notion search"))[0]).toBe("notion__search");
    expect(await names("notion", 3)).toEqual(["notion__action_0", "notion__action_10", "notion__action_100"]);
    expect(await names("notion", 3)).toEqual(await names("notion", 3));
  });

  it("puts an exact name first, and says so when nothing matches", async () => {
    expect((await names("linear__action_1"))[0]).toBe("linear__action_1");
    const r = await find().execute({ query: "zzzz" }, { ...ctx(), callId: "f" });
    expect(textOf(r)).toContain('No connector tool matched "zzzz"');
  });

  it("carries the catalog: lines while it fits, names by connector past the budget", () => {
    const few = find(TOOLS.slice(0, 5)).description;
    expect(few).toContain("Notion:\n- notion__create_page: Create a page in a Notion workspace.");
    const many = find().description;
    expect(many).toMatch(/\nNotion: notion__create_page, notion__search, notion__action_0/);
    expect(many.length).toBeLessThan(9_000);
  });
});

describe("the MCP server in on-demand mode", () => {
  it("lists the two tools in place of the connector tools, and dispatches through them", async () => {
    const set = withConnectors().tools(CHAT, session, "on");
    const asked: string[] = [];
    const server = mcpServer({ tools: set, ctx, approve: askEach(async (q) => { asked.push(q); return true; }) });
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);

    const listed = (await client.listTools()).tools;
    expect(listed.map((t) => t.name)).toEqual(set.list.map((t) => t.name));
    expect(listed.some((t) => t.name.includes("__"))).toBe(false);
    expect(listed.find((t) => t.name === FIND_TOOLS)?.annotations?.readOnlyHint).toBe(true);
    // Codex runs what is marked read-only without asking, and asks before the rest.
    expect(listed.find((t) => t.name === READ_TOOL)?.annotations?.readOnlyHint).toBe(true);
    expect(listed.find((t) => t.name === USE_TOOL)?.annotations?.readOnlyHint).toBeUndefined();

    const found = await client.callTool({ name: FIND_TOOLS, arguments: { query: "create page" } });
    expect((found.content as { text: string }[])[0]!.text).toContain("notion__create_page");
    const used = await client.callTool({ name: USE_TOOL, arguments: { name: "notion__create_page", arguments: { title: "Plan" } } });
    expect(used.isError).toBe(false);
    expect(asked).toEqual(["OpenLive wants to use Notion: create_page. Allow it?"]);
    await client.close();
  });

  it("tells the session the tool that ran, not the one that ran it", async () => {
    const seen: string[] = [];
    const server = mcpServer({ tools: withConnectors().tools(CHAT, session, "on"), ctx, onCall: (e) => { seen.push(`${e.type} ${String(e.name)}`); } });
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    await client.callTool({ name: READ_TOOL, arguments: { name: "notion__search", arguments: { query: "x" } } });
    await client.callTool({ name: USE_TOOL, arguments: { name: "notion__create_page", arguments: { title: "Plan" } } });
    await client.callTool({ name: READ_TOOL, arguments: { name: "notion__create_page", arguments: { title: "Plan" } } });
    expect(seen).toEqual([
      "tool_call notion__search", "tool_result notion__search",
      "tool_call notion__create_page", "tool_result notion__create_page",
      `tool_call ${READ_TOOL}`, `tool_result ${READ_TOOL}`,
    ]);
    await client.close();
  });
});
