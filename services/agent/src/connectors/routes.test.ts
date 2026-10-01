import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "ol-conn-routes-"));
process.env.OPENLIVE_HOME = dir;
process.env.OPENLIVE_ENC_KEY = "12".repeat(32);
const { connectorRoutes } = await import("./routes.ts");
const { connectors } = await import("./manager.ts");
const { listConnectorRows } = await import("@openlive/db");
const mcpFile = join(dir, "mcp.json");

afterAll(async () => {
  await connectors.shutdown();
  delete process.env.OPENLIVE_HOME;
  delete process.env.OPENLIVE_ENC_KEY;
  rmSync(dir, { recursive: true, force: true });
});

const fixture = fileURLToPath(new URL("./fixture-server.fixture.mjs", import.meta.url));
const call = async (method: string, path: string, body?: unknown) => {
  const r = await connectorRoutes.request(path, { method, headers: { "content-type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }) });
  return { status: r.status, json: (await r.json()) as any };
};

describe("the /connectors API", () => {
  let id = "";

  it("adds pasted mcpServers JSON, holding a stdio server until it is allowed to run", async () => {
    const r = await call("POST", "/", { json: JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [fixture], env: { FIXTURE_SECRET: "hidden", MODE: "x" } } } }) });
    expect(r.status).toBe(201);
    const c = r.json.connectors[0];
    id = c.id;
    expect(c).toMatchObject({ name: "fixture", status: "needs_consent", spawnConsent: false, transport: { env: { MODE: "x" }, secretEnv: ["FIXTURE_SECRET"] }, tools: [] });
    expect(JSON.stringify(r.json)).not.toContain("hidden");
  });

  it("starts it on consent and reports its tools", async () => {
    const r = await call("POST", `/${id}/consent`);
    expect(r.json).toMatchObject({ status: "connected", spawnConsent: true });
    expect(r.json.tools.map((t: any) => t.exposedName)).toEqual(["fixture__echo", "fixture__make_note", "fixture__confirm"]);
  });

  it("closes a live connection whose server was changed by hand, and keeps one that was not", async () => {
    await connectors.reconcile(listConnectorRows());
    expect((await call("GET", "/")).json.connectors[0].status).toBe("connected");
    const doc = JSON.parse(readFileSync(mcpFile, "utf8"));
    doc.mcpServers.fixture.env.MODE = "y";
    writeFileSync(mcpFile, JSON.stringify(doc));
    await connectors.reconcile(listConnectorRows());
    expect((await call("GET", "/")).json.connectors[0]).toMatchObject({ status: "disconnected", transport: { env: { MODE: "y" } } });
    expect((await call("POST", `/${id}/reconnect`)).json.status).toBe("connected");
  });

  it("switches one tool, then the whole connector, off", async () => {
    const t = await call("POST", `/${id}/tools/echo/enabled`, { enabled: false });
    expect(t.json.tools.find((x: any) => x.name === "echo").enabled).toBe(false);
    const all = await call("POST", `/${id}/tools/enabled`, { tools: ["make.note", "confirm"], enabled: false });
    expect(all.json.tools.filter((x: any) => !x.enabled).map((x: any) => x.name).sort()).toEqual(["confirm", "echo", "make.note"]);
    const back = await call("POST", `/${id}/tools/enabled`, { tools: ["make.note", "confirm"], enabled: true });
    expect(back.json.tools.filter((x: any) => !x.enabled).map((x: any) => x.name)).toEqual(["echo"]);
    const c = await call("POST", `/${id}/enabled`, { enabled: false });
    expect(c.json.status).toBe("disabled");
  });

  it("refuses a body it cannot read, and an id it does not know", async () => {
    expect((await call("POST", "/", { json: "{nope" })).status).toBe(400);
    expect((await call("POST", "/", { json: { other: 1 } })).status).toBe(400);
    expect((await call("PATCH", "/missing", { name: "x" })).status).toBe(404);
  });

  it("removes it", async () => {
    expect((await call("DELETE", `/${id}`)).status).toBe(200);
    expect((await call("GET", "/")).json).toEqual({ connectors: [], problems: [] });
  });

  it("names what is wrong with an mcp.json broken by hand, and will not write over it", async () => {
    writeFileSync(mcpFile, `{"mcpServers": {"a": {}}`);
    const list = await call("GET", "/");
    expect(list.json.connectors).toEqual([]);
    expect(list.json.problems[0]).toMatch(/^mcp\.json is not valid JSON/);
    const add = await call("POST", "/", { url: "https://x.example/mcp" });
    expect(add.status).toBe(409);
    expect(add.json.error).toMatch(/Fix it by hand/);
    expect(readFileSync(mcpFile, "utf8")).toBe(`{"mcpServers": {"a": {}}`);
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: { a: {} } }));
    expect((await call("GET", "/")).json.problems).toEqual([`"a" needs a "command" to run or a "url" to reach.`]);
  });
});
