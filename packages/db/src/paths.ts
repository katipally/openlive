import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Resolve repo-root-relative data paths regardless of which workspace package
// imports this module. `packages/db/src` → repo root is three levels up.
const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");
export const DATA_DIR = process.env.OPENLIVE_DATA_DIR
  ? resolve(process.env.OPENLIVE_DATA_DIR)
  : resolve(REPO_ROOT, "data");
export const SCRATCH_DIR = resolve(DATA_DIR, "scratch");

/**
 * OpenLive's own Agent Skills, one folder per skill. In the home folder, as
 * ~/.claude/skills and ~/.agents/skills are, rather than under DATA_DIR: that
 * is the app's private store, hidden in packaged builds and split between dev
 * and packaged, and skills are files a person opens, edits and shares.
 * OPENLIVE_SKILLS_DIR moves it. Read per call, so a test can point it anywhere.
 */
export const skillsDir = (): string =>
  process.env.OPENLIVE_SKILLS_DIR ? resolve(process.env.OPENLIVE_SKILLS_DIR) : join(homedir(), ".openlive", "skills");
