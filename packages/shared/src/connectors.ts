// What the agent's /connectors routes send and take. A connector is an MCP
// server added once and offered to every brain in both modes. Secret values
// (env marked secret, header values, OAuth tokens) never appear here: only
// their names, the same way a provider key only shows its last four.

export type ConnectorSource = "manual" | "claude-desktop" | "claude-code" | "codex" | "cursor" | "gemini" | "vscode";

export type ConnectorStatus =
  | "disabled"
  /** A stdio server nobody has agreed to run yet. */
  | "needs_consent"
  | "disconnected"
  | "connecting"
  | "connected"
  /** Sign in with POST /connectors/:id/oauth/start. */
  | "needs_auth"
  | "error";

export type ConnectorTransportWire =
  | { type: "stdio"; command: string; args: string[]; cwd?: string; env: Record<string, string>; secretEnv: string[] }
  | { type: "http"; url: string; headers: string[] };

export interface ConnectorToolWire {
  /** The server's own name for it. */
  name: string;
  /** What the model sees: `<slug>__<name>`, within provider limits. */
  exposedName: string;
  description: string;
  readOnly: boolean;
  enabled: boolean;
}

export interface ConnectorWire {
  id: string;
  name: string;
  /** Stable for the connector's life, so renaming it never renames its tools. */
  slug: string;
  transport: ConnectorTransportWire;
  enabled: boolean;
  source: ConnectorSource;
  createdAt: string;
  /** Always true for http. A stdio server is never started before this. */
  spawnConsent: boolean;
  /** CIMD client id document, when one is configured. */
  clientMetadataUrl?: string;
  signedIn: boolean;
  status: ConnectorStatus;
  error?: string;
  tools: ConnectorToolWire[];
}

/** Everything the store takes to make a connector. Secrets in plain text, once, over loopback. */
export type ConnectorTransportInput =
  | { type: "stdio"; command: string; args?: string[]; cwd?: string; env?: Record<string, string>; secretEnv?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

/** A change to a connector. Secret maps merge: a key set to null is removed, a key left out is kept. */
export interface ConnectorPatch {
  name?: string;
  enabled?: boolean;
  clientMetadataUrl?: string | null;
  command?: string;
  args?: string[];
  cwd?: string | null;
  env?: Record<string, string>;
  secretEnv?: Record<string, string | null>;
  url?: string;
  headers?: Record<string, string | null>;
}

export interface ConnectorImportCandidate {
  /** The server's key in the source file. */
  name: string;
  transport: ConnectorTransportWire;
  /** An existing connector, or an earlier candidate, with the same command or URL. */
  duplicateOf?: string;
  warnings: string[];
}

export interface ConnectorImportSource {
  source: Exclude<ConnectorSource, "manual">;
  label: string;
  path: string;
  found: boolean;
  error?: string;
  servers: ConnectorImportCandidate[];
}
