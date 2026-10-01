import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { layout, migrateHome, resolveHome } from "@openlive/shared/home";

// Resolve repo-root-relative paths regardless of which workspace package
// imports this module. `packages/db/src` → repo root is three levels up.
const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");

/** Every file OpenLive keeps, under its one home (packages/shared/src/home). Resolved once, at import. */
export const PATHS = layout(resolveHome());
// Before any store is read: a dev checkout's flat data/ (or a legacy OPENLIVE_DATA_DIR) is reshaped in place, once.
migrateHome(PATHS.home);

/** The app's working data: the chat database, voice profiles and downloaded models. */
export const DATA_DIR = PATHS.data;
export const SCRATCH_DIR = PATHS.scratch;

/**
 * OpenLive's own Agent Skills, one folder per skill, files a person opens,
 * edits and shares. OPENLIVE_SKILLS_DIR moves it. Read per call, so a test can
 * point it anywhere.
 */
export const skillsDir = (): string => layout(resolveHome()).skills;
