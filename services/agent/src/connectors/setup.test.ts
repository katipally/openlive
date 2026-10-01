import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// The connector-setup skill's tools: what they hand the model holds no secret,
// and adding a server that runs on this computer never allows it to run.

const dir = mkdtempSync(join(tmpdir(), "ol-conn-setup-"));
process.env.OPENLIVE_HOME = dir;
process.env.OPENLIVE_ENC_KEY = "5a".repeat(32);
const db = await import("@openlive/db");
const { CONNECTOR_SETUP_TOOLS } = await import("./setup.ts");
const { connectors } = await import("./manager.ts");
const { ToolSet, dispatchAll } = await import("../capabilities/dispatch.ts");
const { allowAll } = await import("../capabilities/approval.ts");

afterAll(async () => {
  await connectors.shutdown();
  delete process.env.OPENLIVE_HOME;
  delete process.env.OPENLIVE_ENC_KEY;
  rmSync(dir, { recursive: true, force: true });
});

const SECRETS = ["ghp_hidden_value", "tok_hidden_value", "q_hidden_value", "crash_hidden_value"];
const tools = new ToolSet(CONNECTOR_SETUP_TOOLS);
const by = (name: string) => tools.resolve(name)!;
async function run(name: string, args: unknown, approve = allowAll) {
  const [r] = await dispatchAll([{ id: "c1", name, args }], tools, { signal: new AbortController().signal, context: null }, { approve });
  const text = r!.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  for (const s of SECRETS) expect(text + JSON.stringify(r!.details ?? null)).not.toContain(s);
  return { ...r!, text };
}

describe("the connector setup tools", () => {
  it("list read-only, and ask before adding", () => {
    expect(by("list_connectors")).toMatchObject({ readOnly: true, group: "connectors" });
    expect(by("list_connectors").confirm).toBeUndefined();
    expect(by("add_connector").confirm!({ url: "https://mcp.example.com/mcp?key=x" })).toBe("add the connector https://mcp.example.com/mcp");
    expect(by("connector_sign_in").confirm).toBeUndefined();
  });

  it("add nothing on a no", async () => {
    const r = await run("add_connector", { url: "http://127.0.0.1:1/mcp" }, async () => ({ block: true, reason: "no" }));
    expect(r.isError).toBe(true);
    expect(db.listConnectorRows()).toEqual([]);
  });

  it("add a local server held until the user allows it, which no tool can do, and never echo its env", async () => {
    const json = JSON.stringify({ mcpServers: { gh: { command: "npx", args: ["-y", "gh-mcp"], env: { GITHUB_TOKEN: "ghp_hidden_value", LOG: "info" }, openlive: { spawnConsent: true } } } });
    const r = await run("add_connector", { json });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("stays off until the user allows it");
    expect(r.text).toContain("no tool can");
    const row = db.listConnectorRows().find((c) => c.name === "gh")!;
    expect(row.spawnConsent).toBe(false);
    expect(db.connectorSecrets(row)).toEqual({ GITHUB_TOKEN: "ghp_hidden_value" });
    expect(r.text).not.toContain("info");
  });

  it("add a remote server with its headers stored encrypted, and show neither headers nor query", async () => {
    const r = await run("add_connector", { url: "http://127.0.0.1:1/mcp?key=q_hidden_value", name: "Remote", headers: { Authorization: "Bearer tok_hidden_value" } });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("http://127.0.0.1:1/mcp");
    const row = db.listConnectorRows().find((c) => c.name === "Remote")!;
    expect(db.connectorSecrets(row)).toEqual({ Authorization: "Bearer tok_hidden_value" });
  });

  it("list every connector with status and tool counts, never a secret, and blank one a server echoes in its error", async () => {
    const crash = await db.createConnector({
      name: "Crash",
      transport: { type: "stdio", command: process.execPath, args: ["-e", "console.error('bad ' + process.env.TOKEN); process.exit(1)"], env: {}, secretEnv: { TOKEN: "crash_hidden_value" } },
    });
    expect((await run("reconnect_connector", { id: crash.id })).text).toContain("waiting for the user to allow it");
    await db.consentToSpawn(crash.id);
    const failed = await run("reconnect_connector", { id: crash.id });
    expect(failed.text).toContain("Status: failed");
    expect(failed.text).toContain("bad [hidden]");
    const list = await run("list_connectors", {});
    expect(list.text.split("\n").map((l) => l.split(" (id")[0])).toEqual(["- gh", "- Remote", "- Crash"]);
    expect(list.text).toContain("no tools listed yet");
  });

  it("sign in only a remote server, and refuse an unknown id", async () => {
    const gh = db.listConnectorRows().find((c) => c.name === "gh")!;
    expect((await run("connector_sign_in", { id: gh.id })).text).toContain("has no sign-in");
    expect((await run("connector_sign_in", { id: "nope" })).text).toContain("There is no connector with id nope");
    const remote = db.listConnectorRows().find((c) => c.name === "Remote")!;
    expect((await run("connector_sign_in", { id: remote.id })).isError).toBe(true);
  });
});
