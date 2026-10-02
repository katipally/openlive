import type { ConnectorSource } from "../connectors";

/** A tool as the server last listed it. Public metadata, kept so a session can offer it without a live connection. */
export interface CachedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

/** Secret maps hold ciphertext: env values marked secret, and every header value. */
export type StoredTransport =
  | { type: "stdio"; command: string; args: string[]; cwd?: string; env: Record<string, string>; secretEnv: Record<string, string> }
  | { type: "http"; url: string; headers: Record<string, string> };

/** One authorization server's credentials, both encrypted. */
export interface IssuerCreds { tokens?: string; client?: string }

export interface ConnectorRow {
  id: string;
  /** Its key in mcp.json, so unique. */
  name: string;
  slug: string;
  source: ConnectorSource;
  createdAt: string;
  enabled: boolean;
  disabledTools: string[];
  /** The person trusts this server's read-only labels: those tools run without asking. A label alone is only the server's claim. */
  trustReadOnly?: true;
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

/** secrets/connectors.json, by connector id. */
export type ConnectorSecrets = Record<string, { env?: Record<string, string>; headers?: Record<string, string>; oauth?: ConnectorRow["oauth"] }>;

export interface McpRead {
  /** null when the file cannot be read at all: it must not be written over. */
  doc: Record<string, unknown> | null;
  rows: ConnectorRow[];
  /** One line per thing wrong, for the Connectors screen. */
  problems: string[];
  /** Servers that could not be used, by key, written back as they are. */
  invalid: Record<string, unknown>;
}

export function slugify(name: string): string;
export function uniqueSlug(name: string, taken: Set<string>): string;
export function uniqueName(name: string, taken: Set<string>): string;
export function runsFingerprint(command: string, args: string[]): string;
export function readMcp(text: string | undefined, secrets: ConnectorSecrets, seal: (plain: string) => string): McpRead;
export function writeMcp(rows: ConnectorRow[], doc?: Record<string, unknown>, invalid?: Record<string, unknown>, oldSecrets?: ConnectorSecrets): { file: Record<string, unknown>; secrets: ConnectorSecrets };
