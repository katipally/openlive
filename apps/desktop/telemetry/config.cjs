"use strict";
// Where events go, and whether this run may send any. Nothing is compiled in:
// the address and client ID are stamped into apps/desktop/telemetry-config.json
// at release time, and a build without that file stays silent.
//   { "endpoint": "https://<host>", "clientId": "<OpenPanel client id>", "origin": "https://<allowed origin>" }
const { isUuid } = require("./validate.cjs");

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const NO_CONTROL_CHARS = /^[^\x00-\x1f\x7f]+$/;

/** The stamped config, or null when it is missing, unreadable or not something safe to send to. */
function loadConfig(fs, file) {
  try {
    const { endpoint, clientId, origin } = JSON.parse(fs.readFileSync(file, "utf8"));
    if (![endpoint, clientId, origin].every((v) => typeof v === "string" && NO_CONTROL_CHARS.test(v)) || !isUuid(clientId)) return null;
    const url = new URL(endpoint);
    const plainOk = url.protocol === "http:" && LOOPBACK.has(url.hostname);
    if (url.protocol !== "https:" && !plainOk) return null;
    return { endpoint, clientId, origin: new URL(origin).origin };
  } catch {
    return null;
  }
}

const hasFlag = (argv, prefix) => argv.some((a) => typeof a === "string" && a.startsWith(prefix));
const word = (v) => String(v ?? "").toLowerCase();

/** Fails closed: any spelling we do not know as "on" is an opt-out, so a typo cannot leave telemetry running. */
const optedOut = ({ OPENLIVE_TELEMETRY, DO_NOT_TRACK }) => {
  const own = word(OPENLIVE_TELEMETRY);
  const dnt = word(DO_NOT_TRACK);
  return (own !== "" && !["1", "true", "on"].includes(own)) || (dnt !== "" && !["0", "false"].includes(dnt));
};

/** False in dev, tests, an unstamped or unpackaged build, a debugger session, and when the person opted out by environment. */
function isActive({ isPackaged, env, argv, config }) {
  return (
    !!config &&
    isPackaged === true &&
    env.ELECTRON_DEV !== "1" &&
    !optedOut(env) &&
    !env.OPENLIVE_FLOW_HOME &&
    !hasFlag(argv, "--remote-debugging") &&
    !hasFlag(argv, "--inspect")
  );
}

module.exports = { loadConfig, isActive };
