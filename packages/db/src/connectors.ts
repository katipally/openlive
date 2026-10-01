import { randomUUID } from "node:crypto";
import type { ConnectorPatch, ConnectorSource, ConnectorTransportInput, ConnectorTransportWire } from "@openlive/shared";
import { readJson, updateJson } from "./store";
import { encryptSecret, decryptSecret } from "./crypto";

// MCP connectors, global to every brain and mode. Same economics as providers:
// one small JSON file, read fresh, written under the cross-process lock. Every
// secret (env values marked secret, header values, OAuth tokens and client
// credentials) is stored as encryptSecret() ciphertext and decrypted only here,
// on the server, at the moment it is used.

const CONNECTORS = "connectors.json";

/** A tool as the server last listed it. Public metadata, kept so a session can offer it without a live connection. */
export interface CachedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

type StoredTransport =
  | { type: "stdio"; command: string; args: string[]; cwd?: string; env: Record<string, string>; secretEnv: Record<string, string> }
  | { type: "http"; url: string; headers: Record<string, string> };

/** One authorization server's credentials, both encrypted. */
interface IssuerCreds { tokens?: string; client?: string }

export interface ConnectorRow {
  id: string;
  name: string;
  slug: string;
  source: ConnectorSource;
  createdAt: string;
  enabled: boolean;
  disabledTools: string[];
  spawnConsent: boolean;
  transport: StoredTransport;
  clientMetadataUrl?: string;
  tools?: CachedTool[];
  toolsAt?: number;
  toolsTtlMs?: number;
  oauth?: {
    /** The issuer whose tokens were saved last, for the per-request token read that carries no issuer. */
    latest?: string;
    issuers: Record<string, IssuerCreds>;
    /** RFC 9728 / 8414 discovery results. Public metadata. */
    discovery?: unknown;
  };
}

export interface ConnectorInput {
  name: string;
  transport: ConnectorTransportInput;
  source?: ConnectorSource;
}

const readRows = () => readJson<ConnectorRow[]>(CONNECTORS, []);

/** Env names that conventionally hold a credential, for input that does not say which are secret. */
const SECRET_NAME = /key|token|secret|passw|pat\b|auth|credential|cookie|session/i;
export const looksSecret = (name: string): boolean => SECRET_NAME.test(name);

/** `GitHub (work)` → `github_work`. Short, because it prefixes every tool name. */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24).replace(/_+$/, "") || "mcp";
}

function uniqueSlug(name: string, rows: ConnectorRow[]): string {
  const taken = new Set(rows.map((r) => r.slug));
  const base = slugify(name);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
}

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

export async function createConnector(input: ConnectorInput): Promise<ConnectorRow> {
  let row!: ConnectorRow;
  await updateJson<ConnectorRow[]>(CONNECTORS, [], (rows) => {
    row = {
      id: randomUUID(),
      name: input.name.trim() || "MCP server",
      slug: uniqueSlug(input.name, rows),
      source: input.source ?? "manual",
      createdAt: new Date().toISOString(),
      enabled: true,
      disabledTools: [],
      // Running a command is the risk; an http server only ever receives requests.
      spawnConsent: input.transport.type === "http",
      transport: storeTransport(input.transport),
    };
    rows.push(row);
    return rows;
  });
  return row;
}

/** Apply `fn` to one row under the lock. Resolves the row as written, or undefined when it is gone. */
async function mutate(id: string, fn: (row: ConnectorRow) => void): Promise<ConnectorRow | undefined> {
  let out: ConnectorRow | undefined;
  await updateJson<ConnectorRow[]>(CONNECTORS, [], (rows) => {
    const row = rows.find((r) => r.id === id);
    if (row) { fn(row); out = row; }
    return rows;
  });
  return out;
}

function mergeSecrets(into: Record<string, string>, patch: Record<string, string | null>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete into[k];
    else into[k] = encryptSecret(v);
  }
}

export function updateConnector(id: string, p: ConnectorPatch): Promise<ConnectorRow | undefined> {
  return mutate(id, (row) => {
    if (p.name !== undefined && p.name.trim()) row.name = p.name.trim();
    if (p.enabled !== undefined) row.enabled = p.enabled;
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
      if (JSON.stringify([t.command, t.args]) !== runs) row.spawnConsent = false;
      if (p.cwd !== undefined) { if (p.cwd) t.cwd = p.cwd; else delete t.cwd; }
      if (p.env !== undefined) t.env = { ...p.env };
      if (p.secretEnv) mergeSecrets(t.secretEnv, p.secretEnv);
    } else {
      if (p.url !== undefined && p.url.trim() !== t.url) {
        t.url = p.url.trim();
        // Tokens belong to the server they were issued for.
        delete row.oauth;
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

export async function removeConnector(id: string): Promise<boolean> {
  let removed = false;
  await updateJson<ConnectorRow[]>(CONNECTORS, [], (rows) => {
    removed = rows.some((r) => r.id === id);
    return rows.filter((r) => r.id !== id);
  });
  return removed;
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
