import { rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR, SCRATCH_DIR } from "./paths";

for (const p of ["providers.json", "settings.json", "conversations.json", "conversations.json.migrated.bak", "openlive.db", "openlive.db-wal", "openlive.db-shm"].map((f) => resolve(DATA_DIR, f)).concat(SCRATCH_DIR)) {
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}
console.log("Reset: cleared local data.");
