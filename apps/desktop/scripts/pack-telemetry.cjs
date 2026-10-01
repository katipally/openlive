"use strict";
// Stamp apps/desktop/telemetry-config.json from the release environment. The ingest
// address is never in source: a build without all three variables writes no file, and
// an unstamped build sends nothing. A stale file from an earlier stamp is removed first,
// so a local build can never ship somebody else's address. The values are never printed.
const fs = require("node:fs");
const path = require("node:path");
const { loadConfig } = require("../telemetry/config.cjs");

const VARS = { endpoint: "OPENLIVE_TELEMETRY_ENDPOINT", clientId: "OPENLIVE_TELEMETRY_CLIENT_ID", origin: "OPENLIVE_TELEMETRY_ORIGIN" };
const FILE = path.resolve(__dirname, "..", "telemetry-config.json");

/** Returns whether a config was stamped. Throws when the variables are set but the sender would refuse them. */
function stamp(env = process.env, file = FILE) {
  fs.rmSync(file, { force: true });
  const config = Object.fromEntries(Object.entries(VARS).map(([key, name]) => [key, String(env[name] ?? "").trim()]));
  if (!Object.values(config).every(Boolean)) return false;
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  if (!loadConfig(fs, file)) {
    fs.rmSync(file, { force: true });
    throw new Error(`[pack-telemetry] ${Object.values(VARS).join(", ")} are set but not usable: the endpoint must be https (or loopback http), the origin a URL and the client ID a UUID.`);
  }
  return true;
}

if (require.main === module) {
  console.log(stamp() ? "[pack-telemetry] stamped telemetry-config.json" : "[pack-telemetry] not all three telemetry variables are set; this build sends no telemetry");
}

module.exports = { stamp, FILE };
