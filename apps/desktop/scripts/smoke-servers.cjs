"use strict";
// electron-builder's afterPack: boot the packaged web and agent servers with the
// packaged Electron as Node and require an HTTP 200 from each, so an app whose
// servers can't start (a dropped node_modules, a missing traced file) fails the
// build instead of shipping a "service keeps crashing" loop. Also checks every
// node_modules dist/ holds made it into the package, since the agent loads its
// native deps lazily and would boot without them, and that the telemetry runtime files
// main requires at launch are in app.asar. Skips builds this host can't run.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { Arch } = require("electron-builder");

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().once("error", reject).listen(0, "127.0.0.1", () => {
    const { port } = s.address(); s.close(() => resolve(port));
  });
});

const status = (url) => new Promise((resolve) => {
  const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode); });
  req.on("error", () => resolve(0));
  req.setTimeout(2000, () => { req.destroy(); resolve(0); });
});

async function boot(exe, script, env, url, timeoutMs = 60000) {
  let log = "";
  const child = spawn(exe, [script], { env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  let exited = null;
  child.once("exit", (code) => { exited = code; });
  try {
    for (const t0 = Date.now(); Date.now() - t0 < timeoutMs && exited === null;) {
      if ((await status(url)) === 200) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`[smoke-servers] ${path.basename(script)} gave no 200 from ${url}${exited === null ? "" : ` (exited ${exited})`}:\n${log.slice(-4000)}`);
  } finally {
    child.kill("SIGKILL");
  }
}

/** The paths inside an asar, read from its header (a size pickle, then the JSON tree) so no asar tool is needed. */
function asarTree(file) {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const json = Buffer.alloc(head.readUInt32LE(12));
    fs.readSync(fd, json, 0, json.length, 16);
    return JSON.parse(json.toString());
  } finally {
    fs.closeSync(fd);
  }
}

/** main.cjs requires these at start-up, so one that electron-builder's `files` missed is a crash on launch. */
function assertTelemetryPackaged(resources) {
  const asar = path.join(resources, "app.asar");
  if (!fs.existsSync(asar)) return;
  const desktop = path.join(__dirname, "..");
  const wanted = [
    "telemetry-map.cjs",
    ...fs.readdirSync(path.join(desktop, "telemetry")).filter((f) => f.endsWith(".cjs") || f === "schema.json").map((f) => `telemetry/${f}`),
    ...(fs.existsSync(path.join(desktop, "telemetry-config.json")) ? ["telemetry-config.json"] : []),
  ];
  const tree = asarTree(asar);
  const missing = wanted.filter((rel) => !rel.split("/").reduce((node, part) => node?.files?.[part], tree));
  if (missing.length) throw new Error(`[smoke-servers] app.asar is missing: ${missing.join(", ")}`);
}

exports.default = async function smokeServers({ appOutDir, electronPlatformName, arch, packager }) {
  if (electronPlatformName !== process.platform || (arch !== Arch.universal && Arch[arch] !== process.arch)) {
    console.log(`[smoke-servers] skipped: can't run ${electronPlatformName}-${Arch[arch]} here`);
    return;
  }
  const name = packager.appInfo.productFilename;
  const mac = process.platform === "darwin";
  const root = mac ? path.join(appOutDir, `${name}.app/Contents`) : appOutDir;
  const resources = path.join(root, mac ? "Resources" : "resources");
  const exe = mac ? path.join(root, "MacOS", name)
    : path.join(root, process.platform === "win32" ? `${name}.exe` : packager.executableName);

  const dist = path.join(__dirname, "..", "dist");
  for (const server of ["web", "agent"]) {
    const want = path.join(dist, server, "node_modules");
    const got = path.join(resources, server, "node_modules");
    if (!fs.existsSync(want)) continue;
    const missing = fs.existsSync(got) ? fs.readdirSync(want).filter((p) => !p.startsWith(".") && !fs.existsSync(path.join(got, p))) : ["node_modules"];
    if (missing.length) throw new Error(`[smoke-servers] packaged ${server} is missing: ${missing.join(", ")}`);
  }
  assertTelemetryPackaged(resources);
  // The built-in skills load from beside agent.mjs; without them the agent boots fine and offers none.
  const skills = fs.existsSync(path.join(dist, "agent", "skills")) ? fs.readdirSync(path.join(dist, "agent", "skills")).filter((s) => !s.startsWith(".")) : [];
  const missingSkills = skills.filter((s) => !fs.existsSync(path.join(resources, "agent", "skills", s, "SKILL.md")));
  if (missingSkills.length) throw new Error(`[smoke-servers] packaged agent is missing built-in skills: ${missingSkills.join(", ")}`);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openlive-smoke-"));
  try {
    const [webPort, agentPort] = [await freePort(), await freePort()];
    await Promise.all([
      boot(exe, path.join(resources, "web/server.js"),
        { PORT: String(webPort), HOSTNAME: "127.0.0.1", NODE_ENV: "production", OPENLIVE_HOME: dataDir, AGENT_PORT: String(agentPort) },
        `http://127.0.0.1:${webPort}/`),
      boot(exe, path.join(resources, "agent/agent.mjs"),
        { AGENT_PORT: String(agentPort), AGENT_HOST: "127.0.0.1", OPENLIVE_HOME: dataDir },
        `http://127.0.0.1:${agentPort}/health`),
    ]);
    console.log(`[smoke-servers] web and agent answered 200 (${electronPlatformName}-${Arch[arch]})`);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
};
