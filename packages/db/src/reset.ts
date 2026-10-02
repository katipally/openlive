import { rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR, PATHS, SCRATCH_DIR } from "./paths";

for (const p of ["conversations.json", "conversations.json.migrated.bak", "openlive.db", "openlive.db-wal", "openlive.db-shm"].map((f) => resolve(DATA_DIR, f)).concat(PATHS.providers, PATHS.settings, PATHS.settingSecrets, PATHS.memory, PATHS.ui, SCRATCH_DIR)) {
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}
console.log("Reset: cleared local data.");
