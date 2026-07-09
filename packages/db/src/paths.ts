import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Resolve repo-root-relative data paths regardless of which workspace package
// imports this module. `packages/db/src` → repo root is three levels up.
const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");
export const DATA_DIR = process.env.OPENLIVE_DATA_DIR
  ? resolve(process.env.OPENLIVE_DATA_DIR)
  : resolve(REPO_ROOT, "data");
export const SCRATCH_DIR = resolve(DATA_DIR, "scratch");
