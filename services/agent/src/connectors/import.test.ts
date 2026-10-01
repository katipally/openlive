import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ConnectorRow } from "@openlive/db";
import { fromCodex, fromGemini, fromMcpServers, fromVsCode, importSources, preview, readSource } from "./import.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const json = (name: string) => JSON.parse(fixture(name)) as unknown;

describe("reading other tools' MCP configs", () => {
  it("Claude Desktop: stdio servers, with key-like env kept apart as secret", () => {
    const found = fromMcpServers(json("claude_desktop_config.json"));
    expect(found.map((f) => f.name)).toEqual(["filesystem", "github"]);
    expect(found[1]!.transport).toEqual({
      type: "stdio", command: "docker", args: ["run", "-i", "--rm", "ghcr.io/github/github-mcp-server"],
      env: { LOG_LEVEL: "info" }, secretEnv: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_fixture" },
    });
  });

  it("Claude Code: user scope only, http and sse, and a ${VAR} it would fill itself left for the user", () => {
    const found = fromMcpServers(json("claude.json"));
    expect(found.map((f) => f.name)).toEqual(["linear", "legacy", "fs"]);
    expect(found[0]!.transport).toEqual({ type: "http", url: "https://mcp.linear.app/mcp", headers: {} });
    expect(found[0]!.warnings[0]).toContain("${LINEAR_TOKEN}");
    expect(found[1]!.transport).toMatchObject({ type: "http", url: "https://legacy.example.com/sse" });
  });

  it("Codex: [mcp_servers] tables, with what Codex fills from its own environment named", () => {
    const found = fromCodex(fixture("codex-config.toml"));
    expect(found.map((f) => f.name)).toEqual(["context7", "figma"]);
    expect(found[0]!.transport).toEqual({ type: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"], env: { REGION: "eu" }, secretEnv: { CONTEXT7_API_KEY: "c7_fixture" } });
    expect(found[0]!.warnings.join()).toContain("CONTEXT7_HOME");
    expect(found[1]!.transport).toEqual({ type: "http", url: "https://mcp.figma.com/mcp", headers: { "X-Figma-Region": "us-east-1" } });
    expect(found[1]!.warnings.join(" ")).toMatch(/turned off.*FIGMA_OAUTH_TOKEN.*FIGMA_ORG/);
  });

  it("Cursor: url servers and stdio with a folder", () => {
    const found = fromMcpServers(json("cursor-mcp.json"));
    expect(found[0]!.transport).toEqual({ type: "http", url: "https://mcp.notion.com/mcp", headers: {} });
    expect(found[1]!.transport).toMatchObject({ type: "stdio", command: "uvx", cwd: "~/data" });
  });

  it("Gemini CLI: httpUrl, url (SSE) and command", () => {
    const found = fromGemini(json("gemini-settings.json"));
    expect(found.map((f) => [f.name, f.transport.type])).toEqual([["stream", "http"], ["events", "http"], ["local", "stdio"]]);
    expect(found[0]!.transport).toEqual({ type: "http", url: "https://stream.example.com/mcp", headers: { "X-Api-Key": "gem_fixture" } });
    expect(found[2]!.transport).toMatchObject({ cwd: "./srv", secretEnv: { SECRET_TOKEN: "tok_fixture" } });
  });

  it("VS Code: servers, with ${input:} prompts and envFile named instead of imported", () => {
    const found = fromVsCode(json("vscode-mcp.json"));
    expect(found.map((f) => f.name)).toEqual(["perplexity", "fetch", "remote"]);
    expect(found[0]!.transport).toMatchObject({ env: {}, secretEnv: {} });
    expect(found[0]!.warnings.join(" ")).toMatch(/\$\{input:perplexity-key\}.*\.env/);
  });

  it("a paste may be the bare server map; a config file may not", () => {
    const bare = { s: { command: "x" } };
    expect(fromMcpServers(bare, "mcpServers", true)).toHaveLength(1);
    expect(fromMcpServers(bare)).toEqual([]);
  });
});

describe("where each tool keeps its config", () => {
  const paths = (platform: NodeJS.Platform, env: Record<string, string> = {}, home = platform === "win32" ? "C:\\Users\\me" : "/home/me") =>
    Object.fromEntries(importSources(platform, env, home).map((s) => [s.id, s.paths]));

  it("on macOS", () => {
    const p = paths("darwin", {}, "/Users/me");
    expect(p["claude-desktop"]).toEqual(["/Users/me/Library/Application Support/Claude/claude_desktop_config.json"]);
    expect(p["claude-code"]).toEqual(["/Users/me/.claude.json"]);
    expect(p.codex).toEqual(["/Users/me/.codex/config.toml"]);
    expect(p.cursor).toEqual(["/Users/me/.cursor/mcp.json"]);
    expect(p.gemini).toEqual(["/Users/me/.gemini/settings.json"]);
    expect(p.vscode).toEqual(["/Users/me/Library/Application Support/Code/User/mcp.json"]);
  });

  it("on Windows, including the Store build of Claude Desktop", () => {
    const p = paths("win32", { APPDATA: "C:\\Users\\me\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" });
    expect(p["claude-desktop"]).toEqual([
      "C:\\Users\\me\\AppData\\Roaming\\Claude\\claude_desktop_config.json",
      "C:\\Users\\me\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\claude_desktop_config.json",
    ]);
    expect(p["claude-code"]).toEqual(["C:\\Users\\me\\.claude.json"]);
    expect(p.vscode).toEqual(["C:\\Users\\me\\AppData\\Roaming\\Code\\User\\mcp.json"]);
  });

  it("on Linux, following XDG and each tool's home override", () => {
    const p = paths("linux", { XDG_CONFIG_HOME: "/xdg", CODEX_HOME: "/codex", CLAUDE_CONFIG_DIR: "/cc" });
    expect(p["claude-desktop"]).toEqual(["/xdg/Claude/claude_desktop_config.json"]);
    expect(p.vscode).toEqual(["/xdg/Code/User/mcp.json"]);
    expect(p.codex).toEqual(["/codex/config.toml"]);
    expect(p["claude-code"]).toEqual(["/cc/.claude.json"]);
    expect(paths("linux").vscode).toEqual(["/home/me/.config/Code/User/mcp.json"]);
  });
});

describe("the import preview", () => {
  const files: Record<string, string> = {
    "/home/me/.claude.json": fixture("claude.json"),
    "/home/me/.config/Claude/claude_desktop_config.json": fixture("claude_desktop_config.json"),
    "/home/me/.cursor/mcp.json": "{ not json",
  };
  const read = (p: string) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]!; };
  const sources = importSources("linux", {}, "/home/me").map((s) => readSource(s, read));
  const existing = [{ name: "Linear", transport: { type: "http", url: "https://MCP.linear.app/mcp/", headers: {} } }] as unknown as ConnectorRow[];
  const out = preview(existing, sources);
  const by = Object.fromEntries(out.map((s) => [s.source, s]));

  it("says which files exist and which could not be read", () => {
    expect(by.codex!.found).toBe(false);
    expect(by.cursor!.error).toMatch(/Could not read/);
  });

  it("marks a server already added, or listed by another tool first", () => {
    expect(by["claude-code"]!.servers.find((s) => s.name === "linear")!.duplicateOf).toBe("Linear");
    expect(by["claude-code"]!.servers.find((s) => s.name === "fs")!.duplicateOf).toBe("filesystem (Claude Desktop)");
  });

  it("never shows a secret value, only its name", () => {
    const github = by["claude-desktop"]!.servers.find((s) => s.name === "github")!;
    expect(github.transport).toMatchObject({ secretEnv: ["GITHUB_PERSONAL_ACCESS_TOKEN"] });
    expect(JSON.stringify(out)).not.toContain("ghp_fixture");
  });
});
