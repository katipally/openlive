import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { parse as parseToml } from "smol-toml";
import { looksSecret, type ConnectorRow } from "@openlive/db";
import type { ConnectorImportCandidate, ConnectorImportSource, ConnectorTransportInput, ConnectorTransportWire } from "@openlive/shared";

// Bringing MCP servers over from the other tools on this machine. Only the
// definitions come over (command, args, env, URL, headers); no tool's stored
// sign-in ever does. Paths and formats as each tool documents them, checked
// 2026-10-01.

export type ImportSourceId = ConnectorImportSource["source"];

/** A server definition read from somewhere, before it is a connector. */
export interface Found {
  name: string;
  transport: ConnectorTransportInput;
  warnings: string[];
}

interface SourceSpec {
  id: ImportSourceId;
  label: string;
  /** Every place this tool keeps the file on this OS, most likely first. */
  paths: string[];
  parse(raw: string): Found[];
}

type Env = Record<string, string | undefined>;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): Record<string, string> =>
  isObj(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string")) : {};
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Values the other tool fills in itself (`${input:x}`, `${VAR}`). Kept out, and named, so nothing literal like `${API_KEY}` is sent. */
const PLACEHOLDER = /\$\{[^}]+\}/;

function stdio(name: string, e: Record<string, unknown>, warnings: string[]): Found | null {
  if (typeof e.command !== "string" || !e.command.trim()) return null;
  const env: Record<string, string> = {};
  const secretEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(strings(e.env))) {
    if (PLACEHOLDER.test(v)) { warnings.push(`${k} refers to ${v.match(PLACEHOLDER)![0]}; set its value after importing.`); continue; }
    (looksSecret(k) ? secretEnv : env)[k] = v;
  }
  const cwd = typeof e.cwd === "string" && e.cwd ? e.cwd : undefined;
  return { name, transport: { type: "stdio", command: e.command, args: list(e.args), ...(cwd && { cwd }), env, secretEnv }, warnings };
}

function http(name: string, url: unknown, rawHeaders: unknown, warnings: string[]): Found | null {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
  if (PLACEHOLDER.test(url)) { warnings.push(`The URL refers to ${url.match(PLACEHOLDER)![0]}; it cannot be imported as is.`); return null; }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(strings(rawHeaders))) {
    if (PLACEHOLDER.test(v)) { warnings.push(`The ${k} header refers to ${v.match(PLACEHOLDER)![0]}; set it after importing.`); continue; }
    headers[k] = v;
  }
  return { name, transport: { type: "http", url, headers }, warnings };
}

/**
 * The common `{ mcpServers: { name: entry } }` shape (Claude Desktop, Claude
 * Code, Cursor, and pasted JSON). `bare` also takes a `{ name: entry }` map,
 * for a paste; never for a file, where other top-level keys are not servers.
 */
export function fromMcpServers(json: unknown, key = "mcpServers", bare = false): Found[] {
  const servers = isObj(json) && isObj(json[key]) ? json[key] : bare ? json : undefined;
  if (!isObj(servers)) return [];
  return Object.entries(servers).flatMap(([name, e]) => {
    if (!isObj(e)) return [];
    const warnings: string[] = [];
    const type = typeof e.type === "string" ? e.type : "";
    const found = type === "http" || type === "sse" || type === "streamable-http" || (!e.command && e.url)
      ? http(name, e.url, e.headers, warnings)
      : stdio(name, e, warnings);
    return found ? [found] : [];
  });
}

/**
 * Claude Code's ~/.claude.json: user scope at the top, then each project's own
 * (local scope) under `projects[path]`. A name is kept once: user scope first,
 * as the one every project sees, then the first project that defines it.
 * O(servers).
 */
export function fromClaudeCode(json: unknown): Found[] {
  const out = fromMcpServers(json);
  const names = new Set(out.map((f) => f.name));
  const projects = isObj(json) && isObj(json.projects) ? json.projects : {};
  for (const [dir, project] of Object.entries(projects)) {
    for (const f of fromMcpServers(project)) {
      if (names.has(f.name)) continue;
      names.add(f.name);
      out.push({ ...f, warnings: [`Claude Code uses it only in ${dir}.`, ...f.warnings] });
    }
  }
  return out;
}

/** Gemini CLI: `httpUrl` is streamable HTTP, `url` is SSE, `command` is stdio. */
export function fromGemini(json: unknown): Found[] {
  const servers = isObj(json) && isObj(json.mcpServers) ? json.mcpServers : {};
  return Object.entries(servers).flatMap(([name, e]) => {
    if (!isObj(e)) return [];
    const warnings: string[] = [];
    const found = e.command ? stdio(name, e, warnings) : http(name, e.httpUrl ?? e.url, e.headers, warnings);
    return found ? [found] : [];
  });
}

/** VS Code's user mcp.json: `servers`, with secrets as `${input:id}` prompts it fills itself. */
export function fromVsCode(json: unknown): Found[] {
  return fromMcpServers(json, "servers").map((f) => {
    const e = isObj(json) && isObj(json.servers) ? json.servers[f.name] : undefined;
    if (isObj(e) && typeof e.envFile === "string") f.warnings.push(`It also reads ${e.envFile}, which is not imported.`);
    return f;
  });
}

/** Codex: `[mcp_servers.<name>]` in config.toml. */
export function fromCodex(raw: string): Found[] {
  const toml = parseToml(raw) as Record<string, unknown>;
  const servers = isObj(toml.mcp_servers) ? toml.mcp_servers : {};
  return Object.entries(servers).flatMap(([name, e]) => {
    if (!isObj(e)) return [];
    const warnings: string[] = [];
    if (e.enabled === false) warnings.push("It is turned off in Codex.");
    if (e.command) {
      if (list(e.env_vars).length) warnings.push(`Codex passes ${list(e.env_vars).join(", ")} through from its own environment; set them after importing.`);
      const found = stdio(name, e, warnings);
      return found ? [found] : [];
    }
    const headers = strings(e.http_headers);
    if (typeof e.bearer_token_env_var === "string") warnings.push(`Codex reads a bearer token from $${e.bearer_token_env_var}; add it as an Authorization header after importing.`);
    for (const [h, v] of Object.entries(strings(e.env_http_headers))) warnings.push(`Codex fills the ${h} header from $${v}; set it after importing.`);
    const found = http(name, e.url, headers, warnings);
    return found ? [found] : [];
  });
}

const json = (parse: (j: unknown) => Found[]) => (raw: string) => parse(JSON.parse(raw));

/** Where each tool keeps its config on this OS. Pure, so every OS's answer can be tested from any one. */
export function importSources(platform: NodeJS.Platform = process.platform, env: Env = process.env, home: string = homedir()): SourceSpec[] {
  const win = platform === "win32";
  const { join } = win ? win32 : posix;
  const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
  const xdg = env.XDG_CONFIG_HOME || join(home, ".config");
  const userConfig = win ? appData : platform === "darwin" ? join(home, "Library", "Application Support") : xdg;
  const claudeDesktop = [join(userConfig, "Claude", "claude_desktop_config.json")];
  // The Microsoft Store build keeps its own copy under its package folder.
  if (win) claudeDesktop.push(join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Packages", "Claude_pzs8sxrjxfjjc", "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"));
  return [
    { id: "claude-desktop", label: "Claude Desktop", paths: claudeDesktop, parse: json((j) => fromMcpServers(j)) },
    { id: "claude-code", label: "Claude Code", paths: [join(env.CLAUDE_CONFIG_DIR || home, ".claude.json")], parse: json(fromClaudeCode) },
    { id: "codex", label: "Codex", paths: [join(env.CODEX_HOME || join(home, ".codex"), "config.toml")], parse: fromCodex },
    { id: "cursor", label: "Cursor", paths: [join(home, ".cursor", "mcp.json")], parse: json((j) => fromMcpServers(j)) },
    { id: "gemini", label: "Gemini CLI", paths: [join(home, ".gemini", "settings.json")], parse: json(fromGemini) },
    { id: "vscode", label: "VS Code", paths: [join(userConfig, "Code", "User", "mcp.json")], parse: json(fromVsCode) },
  ];
}

/** What makes two definitions the same server: the command line it runs, or the URL it talks to. */
export function sameness(t: ConnectorTransportInput | ConnectorRow["transport"]): string {
  if (t.type === "stdio") return `stdio:${[t.command, ...(t.args ?? [])].join("\u0000")}`;
  try { const u = new URL(t.url); return `http:${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}`; }
  catch { return `http:${t.url}`; }
}

/** The transport as the preview shows it: secret values reduced to their names. */
export function maskTransport(t: ConnectorTransportInput): ConnectorTransportWire {
  if (t.type === "http") return { type: "http", url: t.url, headers: Object.keys(t.headers ?? {}) };
  return { type: "stdio", command: t.command, args: t.args ?? [], ...(t.cwd && { cwd: t.cwd }), env: t.env ?? {}, secretEnv: Object.keys(t.secretEnv ?? {}) };
}

export interface ReadSource { spec: SourceSpec; path: string; found: boolean; error?: string; servers: Found[] }

/** Read one source's file, the first of its paths that exists. Never throws. */
export function readSource(spec: SourceSpec, read: (p: string) => string = (p) => readFileSync(p, "utf8")): ReadSource {
  for (const path of spec.paths) {
    let raw: string;
    try { raw = read(path); } catch { continue; }
    try { return { spec, path, found: true, servers: spec.parse(raw) }; }
    catch (e) { return { spec, path, found: true, error: `Could not read it: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300), servers: [] }; }
  }
  return { spec, path: spec.paths[0]!, found: false, servers: [] };
}

/**
 * Every source, each server marked when it duplicates an existing connector or
 * one listed before it. O(servers) with a set of what is already there.
 */
export function preview(existing: ConnectorRow[], sources: ReadSource[]): ConnectorImportSource[] {
  const seen = new Map(existing.map((r) => [sameness(r.transport), r.name]));
  return sources.map((s) => ({
    source: s.spec.id,
    label: s.spec.label,
    path: s.path,
    found: s.found,
    ...(s.error && { error: s.error }),
    servers: s.servers.map((f): ConnectorImportCandidate => {
      const key = sameness(f.transport);
      const duplicateOf = seen.get(key);
      if (!duplicateOf) seen.set(key, `${f.name} (${s.spec.label})`);
      return { name: f.name, transport: maskTransport(f.transport), warnings: f.warnings, ...(duplicateOf && { duplicateOf }) };
    }),
  }));
}
