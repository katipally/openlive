export * from "./mcp.mjs";

export interface HomeLayout {
  home: string;
  settings: string;
  mcp: string;
  memory: string;
  skills: string;
  flowHome: string;
  secrets: string;
  encKey: string;
  providers: string;
  connectorSecrets: string;
  settingSecrets: string;
  data: string;
  state: string;
  portalToken: string;
  migration: string;
  logs: string;
  cache: string;
  scratch: string;
  debug: string;
  checkpoints: string;
  /** Flow's own folder: a coding agent's cwd in Flow, and where new files go. */
  workspace: string;
}

type Env = Record<string, string | undefined>;

export const SECRET_SETTINGS: string[];
export const MIGRATION_VERSION: number;
export function userHome(o?: { platform?: string; homedir?: string }): string;
export function resolveHome(o?: { env?: Env; packaged?: boolean; platform?: string; homedir?: string; repoRoot?: string }): string;
export function layout(home?: string, o?: { env?: Env; platform?: string }): HomeLayout;
export function privateDir(dir: string): string;
export function writeAtomic(file: string, text: string | Uint8Array): void;
export function loadKey(keyFile: string, env?: Env): Buffer;
export function encrypt(key: Buffer, plaintext: string): string;
export function decrypt(key: Buffer, stored: string): string;
export interface MigrationReport { version: number; at: string; moved: string[]; backups: string[]; skipped: string[] }
export function migrateHome(home: string, o?: { from?: string; userData?: string; env?: Env; platform?: string; homedir?: string }): MigrationReport | null;
