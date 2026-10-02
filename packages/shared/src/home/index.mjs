// OpenLive's home folder: where every file OpenLive owns lives, and the one-time
// move into it from the old places. Plain ESM on Node builtins only, because the
// Electron main process loads this same file (as a packaged resource) as do the
// db, flow-store, agent and web packages: one source of truth for every path.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeMcp } from "./mcp.mjs";

export * from "./mcp.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const POSIX = (platform) => platform !== "win32";
const pathFor = (platform) => (platform === "win32" ? path.win32 : path.posix);

/** Settings that hold a secret: kept encrypted in secrets/settings.json, never in settings.json. */
export const SECRET_SETTINGS = ["exa_api_key", "voiceprint"];

/** `~/.openlive` (`%USERPROFILE%\.openlive` on Windows), the installed app's home. */
export const userHome = ({ platform = process.platform, homedir = os.homedir() } = {}) => pathFor(platform).join(homedir, ".openlive");

/**
 * OPENLIVE_HOME, else the legacy OPENLIVE_DATA_DIR, else `~/.openlive` for the
 * installed app and `<repo>/data` for a dev checkout, so a worktree never
 * touches the real home nor another worktree's. Only Electron main knows it is
 * packaged; it hands the servers OPENLIVE_HOME.
 */
export function resolveHome({ env = process.env, packaged = false, platform = process.platform, homedir = os.homedir(), repoRoot = REPO_ROOT } = {}) {
  const p = pathFor(platform);
  const named = env.OPENLIVE_HOME?.trim() || env.OPENLIVE_DATA_DIR?.trim();
  if (named) return p.resolve(named);
  return packaged ? userHome({ platform, homedir }) : p.join(repoRoot, "data");
}

/** Every path under a home. OPENLIVE_SKILLS_DIR and OPENLIVE_FLOW_HOME still move their one folder. */
export function layout(home = resolveHome(), { env = process.env, platform = process.platform } = {}) {
  const p = pathFor(platform);
  const secrets = p.join(home, "secrets");
  const state = p.join(home, "state");
  const cache = p.join(home, "cache");
  return {
    home,
    settings: p.join(home, "settings.json"),
    mcp: p.join(home, "mcp.json"),
    memory: p.join(home, "memory.json"),
    skills: env.OPENLIVE_SKILLS_DIR ? p.resolve(env.OPENLIVE_SKILLS_DIR) : p.join(home, "skills"),
    flowHome: env.OPENLIVE_FLOW_HOME ? p.resolve(env.OPENLIVE_FLOW_HOME) : home,
    secrets,
    encKey: p.join(secrets, ".enc-key"),
    providers: p.join(secrets, "providers.json"),
    connectorSecrets: p.join(secrets, "connectors.json"),
    settingSecrets: p.join(secrets, "settings.json"),
    data: p.join(home, "data"),
    state,
    portalToken: p.join(state, "portal-token"),
    migration: p.join(state, "migration.json"),
    ui: p.join(state, "ui.json"),
    logs: p.join(home, "logs"),
    cache,
    scratch: p.join(cache, "scratch"),
    debug: p.join(cache, "debug"),
    checkpoints: p.join(cache, "checkpoints"),
    workspace: p.join(home, "workspace"),
  };
}

/** A folder only this user can open. mkdir's mode applies on creation only, so an existing one is tightened too. */
export function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (POSIX(process.platform)) fs.chmodSync(dir, 0o700);
  return dir;
}

/** Temp file and rename, so a reader in another process never sees half a file. */
export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ── secrets at rest: AES-256-GCM, stored as iv:tag:ciphertext in hex ─────────

/**
 * OPENLIVE_ENC_KEY (64 hex characters) when set, else secrets/.enc-key, made on
 * first use. A set but malformed OPENLIVE_ENC_KEY throws: falling back to the
 * file key would encrypt under a key the operator did not choose, and a later
 * "corrected" boot would then fail every decrypt.
 */
export function loadKey(keyFile, env = process.env) {
  const fromEnv = env.OPENLIVE_ENC_KEY?.trim();
  if (fromEnv) {
    if (!/^[0-9a-fA-F]{64}$/.test(fromEnv)) {
      throw new Error("OPENLIVE_ENC_KEY must be exactly 64 hex characters (a 32-byte key). Fix or unset it: OpenLive will not fall back to the auto-generated file key.");
    }
    return Buffer.from(fromEnv, "hex");
  }
  if (fs.existsSync(keyFile)) return Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "hex");
  const key = randomBytes(32);
  privateDir(path.dirname(keyFile));
  // Written aside, then linked into place, which fails when it is already there: two
  // processes making one at once both end up with the first one's whole key.
  const tmp = `${keyFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, key.toString("hex"), { mode: 0o600 });
  try { fs.linkSync(tmp, keyFile); } catch (e) {
    if (e.code !== "EEXIST") throw e;
    return Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "hex");
  } finally { fs.rmSync(tmp, { force: true }); }
  return key;
}

export function encrypt(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${enc.toString("hex")}`;
}

export function decrypt(key, stored) {
  const [ivHex, tagHex, dataHex] = stored.split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("malformed ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}

// ── starting over ────────────────────────────────────────────────────────────

/**
 * Why `home` must not be emptied, or null when it may be. Refused: an empty or
 * relative path, a filesystem root, the user's own home folder or any folder
 * above it, since emptying one of those takes far more than OpenLive's files.
 */
export function wipeRefusal(home, { platform = process.platform, homedir = os.homedir() } = {}) {
  const p = pathFor(platform);
  if (typeof home !== "string" || !home.trim() || !p.isAbsolute(home)) return "The OpenLive folder is not an absolute path.";
  const dir = p.resolve(home);
  if (p.parse(dir).root === dir) return `${dir} is the root of a drive.`;
  const rel = p.relative(dir, p.resolve(homedir));
  const outside = rel === ".." || rel.startsWith(`..${p.sep}`) || p.isAbsolute(rel);
  if (!outside) return `${dir} holds your whole home folder.`;
  return null;
}

/**
 * Empty `home`, keeping the folder itself. Throws the refusal instead when
 * wipeRefusal names one. Symlinks inside are removed, never followed, so
 * nothing outside the folder goes. O(entries under home).
 */
export function wipeHome(home, opts) {
  const no = wipeRefusal(home, opts);
  if (no) throw new Error(no);
  if (!fs.existsSync(home)) return [];
  // A home that is itself a link is judged by where it leads.
  const real = fs.realpathSync(home);
  const via = wipeRefusal(real, opts);
  if (via) throw new Error(via);
  const names = fs.readdirSync(real);
  for (const n of names) fs.rmSync(path.join(real, n), { recursive: true, force: true, maxRetries: 5 });
  return names;
}

// ── the move from the old layout ─────────────────────────────────────────────

export const MIGRATION_VERSION = 1;

/** The old flat data folder's entries and where each goes. `addressee-*` is matched by prefix. */
const DATA_MOVES = [
  [".enc-key", "secrets"], ["providers.json", "secrets"],
  ["openlive.db", "data"], ["openlive.db-wal", "data"], ["openlive.db-shm", "data"],
  ["conversations.json", "data"], ["conversations.json.migrated.bak", "data"],
  ["voice-profiles.json", "data"], ["voice-accel.json", "data"], ["models", "data"], ["voices", "data"],
  ["skills.json", "state"], ["debug", "cache"], ["scratch", "cache"],
];
/** What Electron main kept in its userData. Chromium's own files stay there. */
const USER_DATA_MOVES = ["window-state.json", "appearance.json", "preferences.json", "once.json", "server-pids.json", "telemetry.json", "telemetry-queue.jsonl", "telemetry-off"];

const readText = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return undefined; } };
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const pretty = (v) => `${JSON.stringify(v, null, 2)}\n`;

function sameFile(a, b) {
  const sa = fs.statSync(a), sb = fs.statSync(b);
  if (sa.size !== sb.size) return false;
  const fa = fs.openSync(a, "r"), fb = fs.openSync(b, "r");
  try {
    const ba = Buffer.alloc(1 << 20), bb = Buffer.alloc(1 << 20);
    for (let pos = 0; pos < sa.size;) {
      const n = fs.readSync(fa, ba, 0, ba.length, pos);
      fs.readSync(fb, bb, 0, n, pos);
      if (!ba.subarray(0, n).equals(bb.subarray(0, n))) return false;
      pos += n;
    }
    return true;
  } finally { fs.closeSync(fa); fs.closeSync(fb); }
}

/** Same tree, byte for byte. O(total bytes); only a cross-device move or a rerun after a crash pays it. */
function sameTree(a, b) {
  const sa = fs.statSync(a), sb = fs.statSync(b);
  if (sa.isDirectory() !== sb.isDirectory()) return false;
  if (!sa.isDirectory()) return sameFile(a, b);
  const na = fs.readdirSync(a).sort(), nb = fs.readdirSync(b).sort();
  return na.length === nb.length && na.every((n, i) => n === nb[i] && sameTree(path.join(a, n), path.join(b, n)));
}

/**
 * Rename, or across devices copy to a side name, verify, then put it in place
 * and only then delete the source. A destination that is already there wins:
 * the source is deleted only when it is the same, as after a crash mid-move.
 */
function move(src, dst, report) {
  if (!fs.existsSync(src)) return;
  if (fs.existsSync(dst)) {
    if (sameTree(src, dst)) fs.rmSync(src, { recursive: true, force: true });
    else report.skipped.push(`${src}: ${dst} is already there, so it was left as it is`);
    return;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
  try {
    fs.renameSync(src, dst);
  } catch (e) {
    if (e.code !== "EXDEV") throw e;
    const side = `${dst}.migrating`;
    fs.rmSync(side, { recursive: true, force: true });
    fs.cpSync(src, side, { recursive: true, preserveTimestamps: true });
    if (!sameTree(src, side)) throw new Error(`copy of ${src} did not verify`);
    fs.renameSync(side, dst);
    fs.rmSync(src, { recursive: true, force: true });
  }
  report.moved.push(`${src} -> ${dst}`);
}

function backup(file, P, report) {
  const to = path.join(P.secrets, "backup", path.basename(file));
  if (fs.existsSync(to)) return;
  privateDir(path.dirname(to));
  fs.copyFileSync(file, to);
  fs.chmodSync(to, 0o600);
  report.backups.push(to);
}

/** settings.json loses `agent_notes` (to memory.json) and every secret setting (encrypted into secrets/). */
function splitSettings(file, P, env, report) {
  const raw = readText(file);
  if (raw === undefined) return;
  let s;
  try { s = JSON.parse(raw); } catch { report.skipped.push(`${file}: not valid JSON, left as it is`); return; }
  if (!isObj(s)) return;
  const secret = SECRET_SETTINGS.filter((k) => k in s);
  if (file === P.settings && !("agent_notes" in s) && !secret.length) return;
  backup(file, P, report);
  if (typeof s.agent_notes === "string") {
    let notes;
    try { notes = JSON.parse(s.agent_notes); } catch { notes = []; }
    const have = JSON.parse(readText(P.memory) ?? "[]");
    const seen = new Set(have.map((n) => (typeof n === "string" ? n : n?.text)));
    const add = Array.isArray(notes) ? notes.filter((n) => !seen.has(typeof n === "string" ? n : n?.text)) : [];
    if (add.length || !fs.existsSync(P.memory)) writeAtomic(P.memory, pretty([...have, ...add]));
  }
  const values = secret.filter((k) => typeof s[k] === "string" && s[k]);
  if (values.length) {
    const key = loadKey(P.encKey, env);
    const sealed = JSON.parse(readText(P.settingSecrets) ?? "{}");
    for (const k of values) sealed[k] ??= encrypt(key, s[k]);
    privateDir(P.secrets);
    writeAtomic(P.settingSecrets, pretty(sealed));
  }
  for (const k of ["agent_notes", ...SECRET_SETTINGS]) delete s[k];
  const kept = file === P.settings ? {} : JSON.parse(readText(P.settings) ?? "{}");
  writeAtomic(P.settings, pretty({ ...s, ...kept }));
  if (file !== P.settings) fs.rmSync(file);
}

/** connectors.json becomes mcp.json (no secrets) plus secrets/connectors.json (ciphertext as it was). */
function splitConnectors(file, P, report) {
  const raw = readText(file);
  if (raw === undefined) return;
  let rows;
  try { rows = JSON.parse(raw); } catch { rows = null; }
  if (!Array.isArray(rows)) { report.skipped.push(`${file}: not a list of connectors, left as it is`); return; }
  backup(file, P, report);
  if (fs.existsSync(P.mcp)) {
    const ids = new Set(Object.values(JSON.parse(readText(P.mcp) ?? "{}").mcpServers ?? {}).map((e) => e?.openlive?.id));
    // Already written by a run that stopped before deleting the old file.
    if (rows.every((r) => ids.has(r.id))) fs.rmSync(file);
    else report.skipped.push(`${file}: mcp.json is already there, so it was left as it is`);
    return;
  }
  const { file: doc, secrets } = writeMcp(rows);
  privateDir(P.secrets);
  writeAtomic(P.connectorSecrets, pretty(secrets));
  writeAtomic(P.mcp, pretty(doc));
  fs.rmSync(file);
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** A folder as a lock: mkdir is atomic everywhere. One left by a killed process is taken after 30 s. */
function lock(dir) {
  for (const until = Date.now() + 30_000; Date.now() < until; sleep(50)) {
    try { fs.mkdirSync(dir); return true; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - fs.statSync(dir).mtimeMs > 30_000) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone already */ }
    }
  }
  return false;
}

/**
 * Bring the old layout into `home`, once. `from` is the old flat data folder
 * (default: `home` itself, reshaped in place, which is what a dev checkout's
 * `data/` and a legacy OPENLIVE_DATA_DIR need), `userData` Electron's, whose
 * OpenLive files move to state/. `~/.openlive` itself is never reshaped in
 * place: an old build left a stray openlive.db at its top that is not ours to move.
 *
 * Safe to stop at any point: every step is a rename, or a copy that is verified
 * before its source goes, settings.json and connectors.json are backed up to
 * secrets/backup/ before they are rewritten, and the marker that ends it is
 * written last, so the next start finishes what this one began. Never throws.
 */
export function migrateHome(home, { from, userData, env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  const P = layout(home, { env: {}, platform });
  const src = from ?? (home === userHome({ platform, homedir }) ? undefined : home);
  if ((!src && !userData) || fs.existsSync(P.migration)) return null;
  const report = { version: MIGRATION_VERSION, at: new Date().toISOString(), moved: [], backups: [], skipped: [] };
  try {
    privateDir(home);
    privateDir(P.state);
    const held = path.join(P.state, ".migrate.lock");
    if (!lock(held)) return null;
    try {
      if (fs.existsSync(P.migration)) return null;
      if (src && fs.existsSync(src)) {
        for (const [name, to] of DATA_MOVES) move(path.join(src, name), path.join(P[to], name), report);
        for (const name of fs.readdirSync(src).filter((n) => n.startsWith("addressee-"))) move(path.join(src, name), path.join(P.data, name), report);
        splitSettings(path.join(src, "settings.json"), P, env, report);
        splitConnectors(path.join(src, "connectors.json"), P, report);
      }
      if (userData) {
        for (const name of USER_DATA_MOVES) move(path.join(userData, name), path.join(P.state, name), report);
        if (platform === "linux") {
          const xdg = env.XDG_STATE_HOME?.startsWith("/") ? env.XDG_STATE_HOME : path.join(homedir, ".local", "state");
          move(path.join(xdg, "openlive", "computer-use", "portal-token"), P.portalToken, report);
        }
      }
      if (fs.existsSync(P.secrets)) {
        privateDir(P.secrets);
        for (const f of fs.readdirSync(P.secrets, { recursive: true })) {
          const full = path.join(P.secrets, String(f));
          if (POSIX(platform)) fs.chmodSync(full, fs.statSync(full).isDirectory() ? 0o700 : 0o600);
        }
      }
      const note = `OpenLive ${new Date().toISOString().slice(0, 10)}: what was here moved to ${home}\n` +
        `(settings.json, mcp.json, memory.json, secrets/, data/, state/, cache/). See state/migration.json there for each file.\n`;
      for (const old of [src !== home && src, userData]) if (old && fs.existsSync(old) && report.moved.length) fs.writeFileSync(path.join(old, "MIGRATED.txt"), note);
      writeAtomic(P.migration, pretty(report));
      return report;
    } finally {
      fs.rmSync(held, { recursive: true, force: true });
    }
  } catch (e) {
    console.error(`[home] moving into ${home} stopped; the old files stay where they were and the next start tries again:`, e);
    return null;
  }
}
