import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { layout, resolveHome } from "@openlive/shared/home";

// Flow is deliberately global: one store per OpenLive home, shared by the agent
// service and the web app, with no workspace anywhere in it. Every path is
// resolved per call so a test (or a dev run) can repoint OPENLIVE_FLOW_HOME or
// OPENLIVE_HOME without re-importing the module.

export const flowHome = (): string => layout(resolveHome()).flowHome;

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
