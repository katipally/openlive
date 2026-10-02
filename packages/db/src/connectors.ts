import { randomUUID } from "node:crypto";
import type { ConnectorPatch, ConnectorSource, ConnectorTransportInput, ConnectorTransportWire } from "@openlive/shared";
import { readMcp, uniqueName, uniqueSlug, writeMcp, type CachedTool, type ConnectorRow, type ConnectorSecrets, type StoredTransport } from "@openlive/shared/home";
import { readJson, readText, withFileLock, writeJson } from "./store";
import { encryptSecret, decryptSecret } from "./crypto";
import { PATHS } from "./paths";

// MCP connectors, global to every brain and mode. mcp.json holds them in the
// standard {"mcpServers": {...}} shape, so a person can edit it by hand; every
// secret (env values marked secret, header values, OAuth tokens and client
// credentials) is encryptSecret() ciphertext in secrets/connectors.json, and
// decrypted only here, on the server, at the moment it is used. Read fresh on
// every call, so a hand edit counts at once; written under one cross-process lock.

export { slugify } from "@openlive/shared/home";
export type { CachedTool, ConnectorRow } from "@openlive/shared/home";

export interface ConnectorInput {
  name: string;
  transport: ConnectorTransportInput;
  source?: ConnectorSource;
}

/** mcp.json is there but cannot be read, so nothing is written over it. */
export class McpFileError extends Error {}

const load = () => readMcp(readText(PATHS.mcp), readJson<ConnectorSecrets>(PATHS.connectorSecrets, {}), encryptSecret);
const readRows = () => load().rows;

/** What is wrong with mcp.json as written, one line each, for the Connectors screen. */
export const connectorProblems = (): string[] => load().problems;

/** Change the rows under the lock. `names` holds every server key in the file, the unusable ones too. */
function updateRows<R>(fn: (rows: ConnectorRow[], names: Set<string>) => R): Promise<R> {
  return withFileLock(PATHS.mcp, () => {
    const cur = load();
    if (!cur.doc) throw new McpFileError(`${cur.problems[0]} Fix it by hand, then try again.`);
    const out = fn(cur.rows, new Set([...cur.rows.map((r) => r.name), ...Object.keys(cur.invalid)]));
    const { file, secrets } = writeMcp(cur.rows, cur.doc, cur.invalid, readJson<ConnectorSecrets>(PATHS.connectorSecrets, {}));
    // Secrets first: a reference in mcp.json never points at nothing.
    writeJson(PATHS.connectorSecrets, secrets);
    writeJson(PATHS.mcp, file);
    return out;
  });
}

/** Env names that conventionally hold a credential, for input that does not say which are secret. */
const SECRET_NAME = /key|token|secret|passw|pat\b|auth|credential|cookie|session/i;
export const looksSecret = (name: string): boolean => SECRET_NAME.test(name);

const encryptAll = (m: Record<string, string> = {}) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, encryptSecret(v)]));

function storeTransport(t: ConnectorTransportInput): StoredTransport {
  if (t.type === "http") return { type: "http", url: t.url.trim(), headers: encryptAll(t.headers) };
  return { type: "stdio", command: t.command.trim(), args: t.args ?? [], ...(t.cwd && { cwd: t.cwd }), env: { ...t.env }, secretEnv: encryptAll(t.secretEnv) };
}

/** The transport as the UI may see it: secret values reduced to their names. */
export function transportWire(t: StoredTransport): ConnectorTransportWire {
  if (t.type === "http") return { type: "http", url: t.url, headers: Object.keys(t.headers) };
  return { type: "stdio", command: t.command, args: t.args, ...(t.cwd && { cwd: t.cwd }), env: t.env, secretEnv: Object.keys(t.secretEnv) };
}

export function listConnectorRows(): ConnectorRow[] {
  return readRows();
}

export function getConnectorRow(id: string): ConnectorRow | undefined {
  return readRows().find((r) => r.id === id);
}

export function createConnector(input: ConnectorInput): Promise<ConnectorRow> {
  return updateRows((rows, names) => {
    const row: ConnectorRow = {
      id: randomUUID(),
      name: uniqueName(input.name.trim() || "MCP server", names),
      slug: uniqueSlug(input.name, new Set(rows.map((r) => r.slug))),
      source: input.source ?? "manual",
      createdAt: new Date().toISOString(),
      enabled: true,
      disabledTools: [],
      // Running a command is the risk; an http server only ever receives requests.
      spawnConsent: input.transport.type === "http",
      transport: storeTransport(input.transport),
    };
    rows.push(row);
    return row;
  });
}

/** Apply `fn` to one row under the lock. Resolves the row as written, or undefined when it is gone. */
function mutate(id: string, fn: (row: ConnectorRow, names: Set<string>) => void): Promise<ConnectorRow | undefined> {
  return updateRows((rows, names) => {
    const row = rows.find((r) => r.id === id);
    if (row) fn(row, names);
    return row;
  });
}

function mergeSecrets(into: Record<string, string>, patch: Record<string, string | null>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete into[k];
    else into[k] = encryptSecret(v);
  }
}

export function updateConnector(id: string, p: ConnectorPatch): Promise<ConnectorRow | undefined> {
  return mutate(id, (row, names) => {
    if (p.name?.trim() && p.name.trim() !== row.name) { names.delete(row.name); row.name = uniqueName(p.name.trim(), names); }
    if (p.enabled !== undefined) row.enabled = p.enabled;
    if (p.trustReadOnly) row.trustReadOnly = true;
    else if (p.trustReadOnly === false) delete row.trustReadOnly;
    if (p.clientMetadataUrl !== undefined) {
      if (p.clientMetadataUrl) row.clientMetadataUrl = p.clientMetadataUrl;
      else delete row.clientMetadataUrl;
    }
    const t = row.transport;
    if (t.type === "stdio") {
      // What runs is what was agreed to: a new command or new arguments ask again.
      const runs = JSON.stringify([t.command, t.args]);
      if (p.command !== undefined) t.command = p.command.trim();
      if (p.args !== undefined) t.args = p.args;
      if (JSON.stringify([t.command, t.args]) !== runs) { row.spawnConsent = false; delete row.trustReadOnly; }
      if (p.cwd !== undefined) { if (p.cwd) t.cwd = p.cwd; else delete t.cwd; }
      if (p.env !== undefined) t.env = { ...p.env };
      if (p.secretEnv) mergeSecrets(t.secretEnv, p.secretEnv);
    } else {
      if (p.url !== undefined && p.url.trim() !== t.url) {
        t.url = p.url.trim();
        // Tokens, and trust in its labels, belong to the server they were given to.
        delete row.oauth;
        delete row.trustReadOnly;
      }
      if (p.headers) mergeSecrets(t.headers, p.headers);
    }
  });
}

export function setConnectorToolsEnabled(id: string, tools: readonly string[], enabled: boolean): Promise<ConnectorRow | undefined> {
  return mutate(id, (row) => {
    const off = new Set(row.disabledTools);
    for (const tool of tools) if (enabled) off.delete(tool); else off.add(tool);
    row.disabledTools = [...off].sort();
  });
}

export function consentToSpawn(id: string): Promise<ConnectorRow | undefined> {
  return mutate(id, (row) => { row.spawnConsent = true; });
}

export function setConnectorTools(id: string, tools: CachedTool[], ttlMs?: number): Promise<ConnectorRow | undefined> {
  return mutate(id, (row) => {
    row.tools = tools;
    row.toolsAt = Date.now();
    if (ttlMs !== undefined) row.toolsTtlMs = ttlMs; else delete row.toolsTtlMs;
  });
}

export function removeConnector(id: string): Promise<boolean> {
  return updateRows((rows) => {
    const i = rows.findIndex((r) => r.id === id);
    if (i >= 0) rows.splice(i, 1);
    return i >= 0;
  });
}

/** Server-only: the env and headers a connection is made with, decrypted. A value that no longer decrypts is left out. */
export function connectorSecrets(row: ConnectorRow): Record<string, string> {
  const enc = row.transport.type === "stdio" ? row.transport.secretEnv : row.transport.headers;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(enc)) {
    try { out[k] = decryptSecret(v); } catch { /* the enc-key changed; the user re-enters it */ }
  }
  return out;
}

// ── OAuth, keyed by issuer ──────────────────────────────────────────────────
// Client ids and tokens are unique to the authorization server that issued
// them (RFC 6749 §2.2), so each is filed under that server's issuer, and the
// SDK checks the stamp it writes before using either again.

export type OAuthKind = "tokens" | "client";

/** One issuer's credential of this kind, or the latest issuer's when none is named. */
export function getConnectorOAuth<T>(id: string, kind: OAuthKind, issuer?: string): T | undefined {
  const oauth = getConnectorRow(id)?.oauth;
  const key = issuer ?? oauth?.latest;
  const enc = key ? oauth?.issuers[key]?.[kind] : undefined;
  if (!enc) return undefined;
  try { return JSON.parse(decryptSecret(enc)) as T; } catch { return undefined; }
}

export function saveConnectorOAuth(id: string, kind: OAuthKind, issuer: string, value: unknown): Promise<ConnectorRow | undefined> {
  return mutate(id, (row) => {
    row.oauth ??= { issuers: {} };
    (row.oauth.issuers[issuer] ??= {})[kind] = encryptSecret(JSON.stringify(value));
    if (kind === "tokens") row.oauth.latest = issuer;
  });
}

export function saveConnectorDiscovery(id: string, discovery: unknown): Promise<ConnectorRow | undefined> {
  return mutate(id, (row) => { (row.oauth ??= { issuers: {} }).discovery = discovery; });
}

/** Forget credentials the server says are no good. `all` forgets the sign-in entirely. */
export function clearConnectorOAuth(id: string, scope: "all" | OAuthKind | "discovery"): Promise<ConnectorRow | undefined> {
  return mutate(id, (row) => {
    if (!row.oauth) return;
    if (scope === "all") { delete row.oauth; return; }
    if (scope === "discovery") { delete row.oauth.discovery; return; }
    for (const creds of Object.values(row.oauth.issuers)) delete creds[scope];
    if (scope === "tokens") delete row.oauth.latest;
  });
}

export const hasConnectorTokens = (row: ConnectorRow): boolean => !!row.oauth?.latest && !!row.oauth.issuers[row.oauth.latest]?.tokens;
