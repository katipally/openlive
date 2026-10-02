import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The home is read at import, so each test points it at a fresh folder first.
let dir: string;
const load = () => import("./connectors");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ol-conn-"));
  process.env.OPENLIVE_HOME = dir;
  process.env.OPENLIVE_ENC_KEY = "ab".repeat(32);
  vi.resetModules();
});
afterEach(() => {
  delete process.env.OPENLIVE_HOME;
  delete process.env.OPENLIVE_ENC_KEY;
  rmSync(dir, { recursive: true, force: true });
});

const mcpFile = () => join(dir, "mcp.json");
const secretsFile = () => join(dir, "secrets", "connectors.json");
const onDisk = () => readFileSync(mcpFile(), "utf8") + readFileSync(secretsFile(), "utf8");
const mcp = () => JSON.parse(readFileSync(mcpFile(), "utf8")) as { mcpServers: Record<string, Record<string, any>> } & Record<string, unknown>;
const handEdit = (doc: unknown) => writeFileSync(mcpFile(), typeof doc === "string" ? doc : JSON.stringify(doc, null, 2));

describe("the connector store", () => {
  it("never writes a secret in plain text, and hands it back decrypted on the server", async () => {
    const c = await load();
    const stdio = await c.createConnector({ name: "GitHub", transport: { type: "stdio", command: "npx", args: ["-y", "gh-mcp"], env: { LOG: "info" }, secretEnv: { GITHUB_TOKEN: "ghp_supersecret" } } });
    const http = await c.createConnector({ name: "Linear", transport: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer lin_secret" } } });
    await c.saveConnectorOAuth(http.id, "tokens", "https://auth.linear.app", { access_token: "at_secret", token_type: "Bearer" });

    const raw = onDisk();
    for (const secret of ["ghp_supersecret", "lin_secret", "at_secret"]) expect(raw).not.toContain(secret);
    expect(raw).toContain("info");

    expect(c.connectorSecrets(c.getConnectorRow(stdio.id)!)).toEqual({ GITHUB_TOKEN: "ghp_supersecret" });
    expect(c.connectorSecrets(c.getConnectorRow(http.id)!)).toEqual({ Authorization: "Bearer lin_secret" });
    expect(c.transportWire(c.getConnectorRow(http.id)!.transport)).toEqual({ type: "http", url: "https://mcp.linear.app/mcp", headers: ["Authorization"] });
    expect(c.transportWire(c.getConnectorRow(stdio.id)!.transport)).toMatchObject({ env: { LOG: "info" }, secretEnv: ["GITHUB_TOKEN"] });
  });

  it("writes the standard mcpServers shape, with each secret a reference into secrets/", async () => {
    const c = await load();
    const s = await c.createConnector({ name: "GitHub", transport: { type: "stdio", command: "npx", args: ["-y", "gh-mcp"], env: { LOG: "info" }, secretEnv: { GITHUB_TOKEN: "ghp_x" } } });
    await c.createConnector({ name: "Linear", transport: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer y" } } });
    const doc = mcp();
    expect(doc.mcpServers.GitHub).toMatchObject({ command: "npx", args: ["-y", "gh-mcp"], env: { LOG: "info", GITHUB_TOKEN: "${secret:GITHUB_TOKEN}" }, openlive: { id: s.id, slug: "github", enabled: true } });
    expect(doc.mcpServers.Linear).toMatchObject({ type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "${secret:Authorization}" } });
    const sealed = JSON.parse(readFileSync(secretsFile(), "utf8"));
    expect(sealed[s.id].env.GITHUB_TOKEN).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    if (process.platform !== "win32") {
      expect(statSync(join(dir, "secrets")).mode & 0o777).toBe(0o700);
      expect(statSync(secretsFile()).mode & 0o777).toBe(0o600);
    }
  });

  it("gives every connector a unique slug that survives a rename", async () => {
    const c = await load();
    const a = await c.createConnector({ name: "My Notes!", transport: { type: "http", url: "https://a.example/mcp" } });
    const b = await c.createConnector({ name: "my notes", transport: { type: "http", url: "https://b.example/mcp" } });
    expect([a.slug, b.slug]).toEqual(["my_notes", "my_notes_2"]);
    await c.updateConnector(a.id, { name: "Renamed" });
    expect(c.getConnectorRow(a.id)!.slug).toBe("my_notes");
    expect(c.slugify("")).toBe("mcp");
    expect(c.slugify("x".repeat(80)).length).toBeLessThanOrEqual(24);
  });

  it("asks before a stdio server first runs, and again when what runs changes", async () => {
    const c = await load();
    const s = await c.createConnector({ name: "fs", transport: { type: "stdio", command: "npx", args: ["fs-mcp"] } });
    const h = await c.createConnector({ name: "web", transport: { type: "http", url: "https://w.example/mcp" } });
    expect(s.spawnConsent).toBe(false);
    expect(h.spawnConsent).toBe(true);
    await c.consentToSpawn(s.id);
    await c.updateConnector(s.id, { env: { A: "1" } });
    expect(c.getConnectorRow(s.id)!.spawnConsent).toBe(true);
    await c.updateConnector(s.id, { args: ["fs-mcp", "/"] });
    expect(c.getConnectorRow(s.id)!.spawnConsent).toBe(false);
  });

  it("merges secret patches: null removes, a missing key is kept", async () => {
    const c = await load();
    const h = await c.createConnector({ name: "h", transport: { type: "http", url: "https://h.example/mcp", headers: { A: "1", B: "2" } } });
    await c.updateConnector(h.id, { headers: { A: null, C: "3" } });
    expect(c.connectorSecrets(c.getConnectorRow(h.id)!)).toEqual({ B: "2", C: "3" });
  });

  it("toggles single tools", async () => {
    const c = await load();
    const h = await c.createConnector({ name: "h", transport: { type: "http", url: "https://h.example/mcp" } });
    await c.setConnectorToolsEnabled(h.id, ["delete_all"], false);
    await c.setConnectorToolsEnabled(h.id, ["archive"], false);
    await c.setConnectorToolsEnabled(h.id, ["archive"], true);
    expect(c.getConnectorRow(h.id)!.disabledTools).toEqual(["delete_all"]);
  });

  it("toggles many tools at once", async () => {
    const c = await load();
    const h = await c.createConnector({ name: "h", transport: { type: "http", url: "https://h.example/mcp" } });
    await c.setConnectorToolsEnabled(h.id, ["b", "a", "c"], false);
    await c.setConnectorToolsEnabled(h.id, ["a", "c"], true);
    expect(c.getConnectorRow(h.id)!.disabledTools).toEqual(["b"]);
  });

  it("trusts read-only labels only when told to, and forgets it when the server changes", async () => {
    const c = await load();
    const h = await c.createConnector({ name: "t", transport: { type: "http", url: "https://t.example/mcp" } });
    expect(c.getConnectorRow(h.id)!.trustReadOnly).toBeUndefined();
    await c.updateConnector(h.id, { trustReadOnly: true });
    expect(c.getConnectorRow(h.id)!.trustReadOnly).toBe(true);
    await c.updateConnector(h.id, { url: "https://other.example/mcp" });
    expect(c.getConnectorRow(h.id)!.trustReadOnly).toBeUndefined();
  });
});

describe("mcp.json edited by hand", () => {
  it("picks up a server added by hand, asks before running it, and seals a plain header on the next write", async () => {
    handEdit({ $schema: "x", mcpServers: {
      "Local files": { command: "npx", args: ["fs-mcp"], env: { ROOT: "/tmp" }, timeout: 5000 },
      Remote: { url: "https://r.example/mcp", headers: { Authorization: "Bearer hand_secret" } },
    } });
    const c = await load();
    const [fs, remote] = c.listConnectorRows();
    expect(fs).toMatchObject({ name: "Local files", slug: "local_files", enabled: true, spawnConsent: false, source: "manual" });
    expect(fs!.transport).toMatchObject({ type: "stdio", command: "npx", args: ["fs-mcp"], env: { ROOT: "/tmp" } });
    expect(c.connectorSecrets(remote!)).toEqual({ Authorization: "Bearer hand_secret" });
    // Its id holds still across reads, so the UI can act on it.
    expect(c.listConnectorRows()[0]!.id).toBe(fs!.id);

    await c.consentToSpawn(fs!.id);
    const doc = mcp();
    expect(JSON.stringify(doc)).not.toContain("hand_secret");
    expect(doc.mcpServers.Remote!.headers).toEqual({ Authorization: "${secret:Authorization}" });
    expect(doc.$schema).toBe("x");
    expect(doc.mcpServers["Local files"]!.timeout).toBe(5000);
    expect(c.connectorSecrets(c.getConnectorRow(remote!.id)!)).toEqual({ Authorization: "Bearer hand_secret" });
    expect(c.getConnectorRow(fs!.id)!.spawnConsent).toBe(true);
  });

  it("asks again when the command is changed by hand", async () => {
    const c = await load();
    const s = await c.createConnector({ name: "fs", transport: { type: "stdio", command: "npx", args: ["fs-mcp"] } });
    await c.consentToSpawn(s.id);
    const doc = mcp();
    doc.mcpServers.fs!.args = ["evil-mcp"];
    handEdit(doc);
    expect(c.getConnectorRow(s.id)!.spawnConsent).toBe(false);
  });

  it("names an unusable server, leaves it out, and keeps it as written", async () => {
    const c = await load();
    const h = await c.createConnector({ name: "h", transport: { type: "http", url: "https://h.example/mcp" } });
    const doc = mcp();
    doc.mcpServers.broken = { args: ["x"], note: "mine" };
    handEdit(doc);
    expect(c.listConnectorRows().map((r) => r.name)).toEqual(["h"]);
    expect(c.connectorProblems()).toEqual([`"broken" needs a "command" to run or a "url" to reach.`]);
    await c.setConnectorToolsEnabled(h.id, ["a"], false);
    expect(mcp().mcpServers.broken).toEqual({ args: ["x"], note: "mine" });
    // The name stays taken while it is there.
    expect((await c.createConnector({ name: "broken", transport: { type: "http", url: "https://b.example/mcp" } })).name).toBe("broken (2)");
  });

  it("never writes over an mcp.json that is not JSON, and says why", async () => {
    handEdit(`{ "mcpServers": { "a": `);
    const c = await load();
    expect(c.listConnectorRows()).toEqual([]);
    expect(c.connectorProblems()[0]).toMatch(/^mcp\.json is not valid JSON/);
    await expect(c.createConnector({ name: "x", transport: { type: "http", url: "https://x.example/mcp" } })).rejects.toBeInstanceOf(c.McpFileError);
    expect(readFileSync(mcpFile(), "utf8")).toBe(`{ "mcpServers": { "a": `);
  });

  it("keeps names unique, since a name is the key", async () => {
    const c = await load();
    await c.createConnector({ name: "h", transport: { type: "http", url: "https://a.example/mcp" } });
    const b = await c.createConnector({ name: "h", transport: { type: "http", url: "https://b.example/mcp" } });
    expect(b.name).toBe("h (2)");
    expect(Object.keys(mcp().mcpServers)).toEqual(["h", "h (2)"]);
  });
});

describe("OAuth credentials", () => {
  it("are filed per issuer, and the issuer-less read gets the latest tokens", async () => {
    const c = await load();
    const h = await c.createConnector({ name: "h", transport: { type: "http", url: "https://h.example/mcp" } });
    await c.saveConnectorOAuth(h.id, "client", "https://as-one.example", { client_id: "one" });
    await c.saveConnectorOAuth(h.id, "tokens", "https://as-one.example", { access_token: "t1" });
    await c.saveConnectorOAuth(h.id, "client", "https://as-two.example", { client_id: "two" });
    await c.saveConnectorOAuth(h.id, "tokens", "https://as-two.example", { access_token: "t2" });

    expect(c.getConnectorOAuth(h.id, "client", "https://as-one.example")).toEqual({ client_id: "one" });
    expect(c.getConnectorOAuth(h.id, "tokens", "https://as-one.example")).toEqual({ access_token: "t1" });
    expect(c.getConnectorOAuth(h.id, "tokens")).toEqual({ access_token: "t2" });
    expect(c.getConnectorOAuth(h.id, "client", "https://elsewhere.example")).toBeUndefined();
  });

  it("forget tokens, clients, or the whole sign-in", async () => {
    const c = await load();
    const h = await c.createConnector({ name: "h", transport: { type: "http", url: "https://h.example/mcp" } });
    await c.saveConnectorOAuth(h.id, "client", "https://as.example", { client_id: "c" });
    await c.saveConnectorOAuth(h.id, "tokens", "https://as.example", { access_token: "t" });
    expect(c.hasConnectorTokens(c.getConnectorRow(h.id)!)).toBe(true);
    await c.clearConnectorOAuth(h.id, "tokens");
    expect(c.getConnectorOAuth(h.id, "tokens", "https://as.example")).toBeUndefined();
    expect(c.getConnectorOAuth(h.id, "client", "https://as.example")).toEqual({ client_id: "c" });
    await c.clearConnectorOAuth(h.id, "all");
    expect(c.getConnectorRow(h.id)!.oauth).toBeUndefined();
  });

  it("are dropped when the server URL changes", async () => {
    const c = await load();
    const h = await c.createConnector({ name: "h", transport: { type: "http", url: "https://h.example/mcp" } });
    await c.saveConnectorOAuth(h.id, "tokens", "https://as.example", { access_token: "t" });
    await c.updateConnector(h.id, { url: "https://other.example/mcp" });
    expect(c.getConnectorRow(h.id)!.oauth).toBeUndefined();
  });
});
