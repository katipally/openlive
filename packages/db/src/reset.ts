import { rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR, SCRATCH_DIR } from "./paths";

for (const p of ["providers.json", "settings.json", "conversations.json"].map((f) => resolve(DATA_DIR, f)).concat(SCRATCH_DIR)) {
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}
console.log("Reset: cleared local data.");
