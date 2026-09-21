import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Flow is deliberately global: one store per machine, shared by the Electron main
// process, the agent service and the renderer, with no workspace anywhere in it.
// That is why this does NOT reuse packages/db's repo-relative DATA_DIR.
// Every path is resolved per call so a test (or a dev run) can repoint
// OPENLIVE_FLOW_HOME without re-importing the module.

export const flowHome = (): string =>
  process.env.OPENLIVE_FLOW_HOME ? resolve(process.env.OPENLIVE_FLOW_HOME) : join(homedir(), ".openlive");

export const flowDir = (): string => join(flowHome(), "flow");
export const configPath = (): string => join(flowDir(), "config.json");
export const sessionsDir = (): string => join(flowDir(), "sessions");
export const assetsDir = (): string => join(flowDir(), "assets");
export const sessionAssetsDir = (sessionId: string): string => join(assetsDir(), sessionId);
export const leasePath = (): string => join(flowDir(), "lease.json");

/** Create a directory (and its parents) on first use. 0700 keeps transcripts and
 *  captured screenshots private on POSIX; Windows ignores the mode. */
export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
