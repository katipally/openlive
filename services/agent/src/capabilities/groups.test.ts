import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Tool } from "./types.js";

// Its own home: switching a group off here must not reach another file's sessions.
const dir = mkdtempSync(join(tmpdir(), "ol-capabilities-"));
process.env.OPENLIVE_HOME = dir;
const { firstSentence, GROUPS, groupTools } = await import("./groups.js");
const { builtinCatalog, registry } = await import("./registry.js");
const { capabilityRoutes } = await import("./routes.js");
const { CHAT } = await import("./profiles.js");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const tool = (name: string, group: Tool["group"], extra: Partial<Tool> = {}): Tool =>
  ({ name, group, description: `${name} does a thing. More detail here.`, parameters: {}, execute: async () => ({ content: [], details: null }), ...extra });

const call = async (method: string, path: string, body?: unknown) => {
  const r = await capabilityRoutes.request(path, { method, headers: { "content-type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }) });
  return { status: r.status, json: (await r.json()) as any };
};

describe("tool groups", () => {
  it("cuts a description to its first sentence, and a long one to a line", () => {
    expect(firstSentence("Search the web. Returns titles.")).toBe("Search the web.");
    expect(firstSentence("  No full stop\n here ")).toBe("No full stop here");
    expect(firstSentence("v1.2 is fine. Next.")).toBe("v1.2 is fine.");
    expect(firstSentence("x".repeat(400))).toHaveLength(160);
  });

  it("groups in the table's order, skips ungrouped and repeated names, and counts what asks first", () => {
    const groups = groupTools([
      tool("shell", "shell", { confirm: () => "run" }),
      tool("read_file", "files"),
      tool("activate_skill", undefined),
      tool("write_file", "files", { confirm: () => "write" }),
      tool("read_file", "files"),
    ], new Set(["shell"]));
    expect(groups.map((g) => [g.id, g.enabled, g.tools.map((t) => [t.name, t.asksFirst])])).toEqual([
      ["files", true, [["read_file", false], ["write_file", true]]],
      ["shell", false, [["shell", true]]],
    ]);
    expect(groups[0]).toMatchObject({ name: "Files", needs: "Needs a folder in a call", icon: "folder" });
    expect(groups[0]!.tools[0]!.description).toBe("read_file does a thing.");
  });

  it("lists every built-in under a known group, the research worker's included", () => {
    const catalog = builtinCatalog();
    expect(catalog.filter((t) => !t.group).map((t) => t.name)).toEqual([]);
    const ids = groupTools(catalog, new Set()).map((g) => g.id);
    expect(ids).toEqual(Object.keys(GROUPS));
    const web = groupTools(catalog, new Set()).find((g) => g.id === "web")!;
    expect(web.tools.map((t) => t.name)).toEqual(["delegate", "web_search", "fetch_url"]);
  });
});

describe("the /capabilities API", () => {
  const session = { clipboard: { read: async () => "", write: async () => {} }, workspace: () => "/tmp" };

  it("switches a group off for the next session, and back on", async () => {
    expect(registry.tools(CHAT, session).resolve("read_file")).toBeTruthy();
    const off = await call("POST", "/groups/files/enabled", { enabled: false });
    expect(off.status).toBe(200);
    expect(off.json.groups.find((g: any) => g.id === "files").enabled).toBe(false);
    expect(registry.tools(CHAT, session).resolve("read_file")).toBeNull();
    expect(registry.tools(CHAT, session).resolve("remember")).toBeTruthy();
    await call("POST", "/groups/files/enabled", { enabled: true });
    expect(registry.tools(CHAT, session).resolve("read_file")).toBeTruthy();
  });

  it("refuses an unknown group and a bad body", async () => {
    expect((await call("POST", "/groups/nope/enabled", { enabled: false })).status).toBe(404);
    expect((await call("POST", "/groups/toString/enabled", { enabled: false })).status).toBe(404);
    expect((await call("POST", "/groups/files/enabled", { enabled: "no" })).status).toBe(400);
  });

  it("saves the Exa key without ever sending it back, and clears it", async () => {
    const saved = await call("POST", "/exa-key", { key: " exa-secret " });
    expect(saved.json.exaKey).toBe("saved");
    expect(JSON.stringify(saved.json)).not.toContain("exa-secret");
    expect((await call("POST", "/exa-key", { key: "" })).json.exaKey).toBe(process.env.EXA_API_KEY?.trim() ? "env" : null);
  });

  it("says how connector tools load, and switches the mode", async () => {
    expect((await call("GET", "/")).json.onDemand).toEqual({ available: true, mode: "auto", active: false, toolCount: 0, threshold: { tools: 40, tokens: 8000 } });
    expect((await call("POST", "/on-demand", { mode: "on" })).json.onDemand.mode).toBe("on");
    expect((await call("POST", "/on-demand", { mode: "sometimes" })).status).toBe(400);
    expect((await call("POST", "/on-demand", { mode: "auto" })).json.onDemand.mode).toBe("auto");
  });
});
