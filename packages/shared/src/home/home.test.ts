import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decrypt, encrypt, layout, loadKey, migrateHome, readMcp, resolveHome, runsFingerprint, userHome, writeMcp } from "./index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const temps: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "ol-home-")); temps.push(d); return d; };
afterEach(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });

const put = (file: string, body: string | object) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
};
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));
/** Every file under a folder, relative, sorted. */
const tree = (dir: string) => (readdirSync(dir, { recursive: true }) as string[]).filter((f) => statSync(join(dir, f)).isFile()).sort();
const mode = (p: string) => statSync(p).mode & 0o777;
const posix = process.platform !== "win32";

describe("where the home is", () => {
  it("is ~/.openlive for the installed app on every OS, never an XDG folder", () => {
    const env = { XDG_DATA_HOME: "/x/data", XDG_STATE_HOME: "/x/state" };
    expect(resolveHome({ env, packaged: true, platform: "darwin", homedir: "/Users/ada" })).toBe("/Users/ada/.openlive");
    expect(resolveHome({ env, packaged: true, platform: "linux", homedir: "/home/ada" })).toBe("/home/ada/.openlive");
    expect(resolveHome({ env, packaged: true, platform: "win32", homedir: "C:\\Users\\ada" })).toBe("C:\\Users\\ada\\.openlive");
    expect(userHome({ platform: "win32", homedir: "C:\\Users\\ada" })).toBe("C:\\Users\\ada\\.openlive");
  });

  it("is the checkout's data/ in dev, so a worktree never touches the real home or another's", () => {
    expect(resolveHome({ env: {}, packaged: false, platform: "linux", homedir: "/home/ada", repoRoot: "/src/openlive" })).toBe("/src/openlive/data");
    expect(resolveHome({ env: {}, platform: "win32", homedir: "C:\\Users\\ada", repoRoot: "D:\\src\\openlive" })).toBe("D:\\src\\openlive\\data");
    expect(resolveHome({ env: {} })).toBe(resolve(here, "../../../../data"));
  });

  it("is OPENLIVE_HOME when set, then the legacy OPENLIVE_DATA_DIR, in dev and installed alike", () => {
    for (const packaged of [true, false]) {
      const o = { packaged, platform: "linux", homedir: "/home/ada", repoRoot: "/src/openlive" };
      expect(resolveHome({ ...o, env: { OPENLIVE_HOME: "/h" } })).toBe("/h");
      expect(resolveHome({ ...o, env: { OPENLIVE_DATA_DIR: "/d" } })).toBe("/d");
      expect(resolveHome({ ...o, env: { OPENLIVE_HOME: "/h", OPENLIVE_DATA_DIR: "/d" } })).toBe("/h");
      expect(resolveHome({ ...o, env: { OPENLIVE_HOME: "  " } })).toBe(packaged ? "/home/ada/.openlive" : "/src/openlive/data");
    }
    expect(resolveHome({ env: { OPENLIVE_HOME: "C:\\h" }, platform: "win32" })).toBe("C:\\h");
  });

  it("lays everything out under it, with skills and Flow each movable on their own", () => {
    const P = layout("/h", { env: {}, platform: "linux" });
    expect(P).toMatchObject({
      settings: "/h/settings.json", mcp: "/h/mcp.json", memory: "/h/memory.json", skills: "/h/skills", flowHome: "/h",
      encKey: "/h/secrets/.enc-key", providers: "/h/secrets/providers.json", connectorSecrets: "/h/secrets/connectors.json",
      settingSecrets: "/h/secrets/settings.json", data: "/h/data", state: "/h/state", portalToken: "/h/state/portal-token",
      migration: "/h/state/migration.json", logs: "/h/logs", scratch: "/h/cache/scratch", debug: "/h/cache/debug",
    });
    const moved = layout("/h", { env: { OPENLIVE_SKILLS_DIR: "/s", OPENLIVE_FLOW_HOME: "/f" }, platform: "linux" });
    expect([moved.skills, moved.flowHome, moved.settings]).toEqual(["/s", "/f", "/h/settings.json"]);
    expect(layout("C:\\h", { env: {}, platform: "win32" }).encKey).toBe("C:\\h\\secrets\\.enc-key");
  });
});

describe("secrets at rest", () => {
  it("makes a key once, private to this user, and round-trips with it", () => {
    const file = join(temp(), "secrets", ".enc-key");
    const key = loadKey(file, {});
    expect(loadKey(file, {}).equals(key)).toBe(true);
    if (posix) { expect(mode(file)).toBe(0o600); expect(mode(dirname(file))).toBe(0o700); }
    const sealed = encrypt(key, "sk-plain");
    expect(sealed).not.toContain("sk-plain");
    expect(decrypt(key, sealed)).toBe("sk-plain");
  });

  it("takes OPENLIVE_ENC_KEY over the file, and refuses a malformed one", () => {
    const file = join(temp(), ".enc-key");
    expect(loadKey(file, { OPENLIVE_ENC_KEY: "ab".repeat(32) }).toString("hex")).toBe("ab".repeat(32));
    expect(existsSync(file)).toBe(false);
    expect(() => loadKey(file, { OPENLIVE_ENC_KEY: "nope" })).toThrow(/64 hex/);
  });
});

describe("mcp.json", () => {
  it("round-trips rows, and gives a pasted copy of a server its own id and slug", () => {
    const key = loadKey(join(temp(), "k"), {});
    const seal = (v: string) => encrypt(key, v);
    const row = {
      id: "r1", name: "fs", slug: "fs", source: "manual" as const, createdAt: "2026-01-01", enabled: true, disabledTools: ["rm"], spawnConsent: true,
      transport: { type: "stdio" as const, command: "npx", args: ["fs-mcp"], env: { A: "1" }, secretEnv: { T: seal("tok") } },
    };
    const { file, secrets } = writeMcp([row]);
    expect((file.mcpServers as Record<string, { openlive: { spawnConsent: string } }>).fs!.openlive.spawnConsent).toBe(runsFingerprint("npx", ["fs-mcp"]));
    const back = readMcp(JSON.stringify(file), secrets, seal);
    expect(back.problems).toEqual([]);
    expect(back.rows[0]).toMatchObject({ ...row, transport: { ...row.transport, secretEnv: { T: expect.any(String) } } });
    expect(decrypt(key, back.rows[0]!.transport.type === "stdio" ? back.rows[0]!.transport.secretEnv.T! : "")).toBe("tok");

    const doc = file as { mcpServers: Record<string, unknown> };
    doc.mcpServers["fs copy"] = structuredClone(doc.mcpServers.fs);
    const two = readMcp(JSON.stringify(doc), secrets, seal).rows;
    expect(two.map((r) => [r.id === "r1", r.slug])).toEqual([[true, "fs"], [false, "fs_copy"]]);
  });
});

/** The old flat data folder, as a dev checkout's data/ or the installed app's <userData>/data held it. */
function oldDataDir(dir: string) {
  const keyHex = "cd".repeat(32);
  const key = Buffer.from(keyHex, "hex");
  put(join(dir, ".enc-key"), keyHex);
  put(join(dir, "settings.json"), {
    liveModel: "m1", "bind:c1": "codex", exa_api_key: "exa_plain_secret", voiceprint: '{"engine":"e","prints":[]}',
    agent_notes: JSON.stringify(["Their name is Ada.", { id: "n2", text: "They drink tea.", at: 5 }]),
  });
  put(join(dir, "providers.json"), [{ id: "p", name: "OpenAI", kind: "openai", apiKeyCiphertext: encrypt(key, "sk-live-9999"), keyLast4: "9999", isDefault: true }]);
  put(join(dir, "connectors.json"), [
    { id: "c-gh", name: "GitHub", slug: "github", source: "manual", createdAt: "2026-01-01", enabled: true, disabledTools: [], spawnConsent: true,
      transport: { type: "stdio", command: "npx", args: ["gh"], env: { LOG: "1" }, secretEnv: { GITHUB_TOKEN: encrypt(key, "ghp_plain") } }, tools: [{ name: "t", description: "", inputSchema: {}, readOnly: true }], toolsAt: 1 },
    { id: "c-lin", name: "GitHub", slug: "github_2", source: "claude-code", createdAt: "2026-01-02", enabled: false, disabledTools: ["x"], spawnConsent: true,
      transport: { type: "http", url: "https://mcp.example/mcp", headers: { Authorization: encrypt(key, "Bearer plain") } },
      oauth: { latest: "https://as", issuers: { "https://as": { tokens: encrypt(key, '{"access_token":"at_plain"}') } } } },
  ]);
  for (const f of ["openlive.db", "openlive.db-wal", "openlive.db-shm", "voice-profiles.json", "voice-accel.json", "addressee-log.jsonl", "addressee-head.json", "skills.json"]) put(join(dir, f), `{"f":"${f}"}`);
  put(join(dir, "models", "kokoro", "model.onnx"), "weights");
  put(join(dir, "voices", "v1.wav"), "wav");
  put(join(dir, "debug", "tts-capture", "r", "manifest.json"), "{}");
  put(join(dir, "scratch", "s.txt"), "s");
  put(join(dir, "keep-me.txt"), "not ours");
  return key;
}

function expectNewLayout(home: string, key: Buffer) {
  const P = layout(home, { env: {}, platform: process.platform });
  expect(json(P.settings)).toEqual({ liveModel: "m1", "bind:c1": "codex" });
  expect(json(P.memory)).toEqual(["Their name is Ada.", { id: "n2", text: "They drink tea.", at: 5 }]);
  const sealed = json(P.settingSecrets);
  expect(decrypt(key, sealed.exa_api_key)).toBe("exa_plain_secret");
  expect(decrypt(key, sealed.voiceprint)).toBe('{"engine":"e","prints":[]}');
  expect(readFileSync(P.encKey, "utf8")).toBe(key.toString("hex"));
  expect(decrypt(key, json(P.providers)[0].apiKeyCiphertext)).toBe("sk-live-9999");
  for (const f of ["openlive.db", "openlive.db-wal", "openlive.db-shm", "voice-profiles.json", "voice-accel.json", "addressee-log.jsonl", "addressee-head.json", join("models", "kokoro", "model.onnx"), join("voices", "v1.wav")]) {
    expect(existsSync(join(P.data, f)), f).toBe(true);
  }
  expect(json(join(P.state, "skills.json"))).toEqual({ f: "skills.json" });
  expect(existsSync(join(P.debug, "tts-capture", "r", "manifest.json"))).toBe(true);
  expect(existsSync(join(P.scratch, "s.txt"))).toBe(true);

  const doc = json(P.mcp);
  expect(Object.keys(doc.mcpServers)).toEqual(["GitHub", "GitHub (2)"]);
  expect(doc.mcpServers.GitHub).toMatchObject({ command: "npx", args: ["gh"], env: { LOG: "1", GITHUB_TOKEN: "${secret:GITHUB_TOKEN}" }, openlive: { id: "c-gh", slug: "github", spawnConsent: runsFingerprint("npx", ["gh"]) } });
  expect(doc.mcpServers["GitHub (2)"]).toMatchObject({ type: "http", url: "https://mcp.example/mcp", headers: { Authorization: "${secret:Authorization}" }, openlive: { id: "c-lin", enabled: false, source: "claude-code", disabledTools: ["x"] } });
  const rows = readMcp(readFileSync(P.mcp, "utf8"), json(P.connectorSecrets), (v: string) => encrypt(key, v)).rows;
  expect(rows.map((r) => [r.id, r.spawnConsent])).toEqual([["c-gh", true], ["c-lin", true]]);
  const [gh, lin] = rows;
  expect(gh!.transport.type === "stdio" && decrypt(key, gh!.transport.secretEnv.GITHUB_TOKEN!)).toBe("ghp_plain");
  expect(lin!.transport.type === "http" && decrypt(key, lin!.transport.headers.Authorization!)).toBe("Bearer plain");
  expect(decrypt(key, lin!.oauth!.issuers["https://as"]!.tokens!)).toBe('{"access_token":"at_plain"}');

  // Not one secret in plain text, anywhere in the home.
  for (const f of tree(home).filter((f) => !f.startsWith(join("secrets", "backup")))) {
    for (const secret of ["exa_plain_secret", "ghp_plain", "Bearer plain", "at_plain", "sk-live-9999"]) expect(readFileSync(join(home, f), "utf8"), f).not.toContain(secret);
  }
  if (posix) {
    expect(mode(P.secrets)).toBe(0o700);
    for (const f of tree(P.secrets)) expect(mode(join(P.secrets, f)), f).toBe(0o600);
  }
  expect(json(P.migration)).toMatchObject({ version: 1 });
}

describe("moving into the home", () => {
  it("reshapes a dev checkout's flat data/ in place, backs up what it rewrites, and leaves what is not its own", () => {
    const home = temp();
    const key = oldDataDir(home);
    const before = { settings: readFileSync(join(home, "settings.json"), "utf8"), connectors: readFileSync(join(home, "connectors.json"), "utf8") };
    const report = migrateHome(home, { env: {} });
    expect(report?.skipped).toEqual([]);
    expectNewLayout(home, key);
    expect(readFileSync(join(home, "secrets", "backup", "settings.json"), "utf8")).toBe(before.settings);
    expect(readFileSync(join(home, "secrets", "backup", "connectors.json"), "utf8")).toBe(before.connectors);
    expect(existsSync(join(home, "connectors.json"))).toBe(false);
    expect(readFileSync(join(home, "keep-me.txt"), "utf8")).toBe("not ours");
    expect(existsSync(join(home, "MIGRATED.txt"))).toBe(false);
  });

  it("runs once: a second start changes nothing", () => {
    const home = temp();
    oldDataDir(home);
    migrateHome(home, { env: {} });
    const snapshot = tree(home).map((f) => [f, readFileSync(join(home, f), "utf8")]);
    put(join(home, "openlive.db"), "a stray one after the move");
    expect(migrateHome(home, { env: {} })).toBeNull();
    expect(tree(home).filter((f) => f !== "openlive.db").map((f) => [f, readFileSync(join(home, f), "utf8")])).toEqual(snapshot);
    expect(readFileSync(join(home, "openlive.db"), "utf8")).toBe("a stray one after the move");
  });

  it("brings the installed app's files out of userData into ~/.openlive, and never touches the stray db already there", () => {
    const fakeHome = temp();
    const userData = join(fakeHome, "Library", "Application Support", "@openlive", "desktop");
    const key = oldDataDir(join(userData, "data"));
    for (const f of ["window-state.json", "appearance.json", "preferences.json", "once.json", "server-pids.json", "telemetry.json", "telemetry-queue.jsonl", "telemetry-off"]) put(join(userData, f), f);
    put(join(userData, "Local Storage", "leveldb", "000003.log"), "chromium");
    const home = userHome({ homedir: fakeHome });
    for (const f of ["openlive.db", "openlive.db-wal", "openlive.db-shm"]) put(join(home, f), `stray ${f}`);
    put(join(home, "flow", "config.json"), "{}");
    put(join(home, "skills", "s", "SKILL.md"), "---");

    // A server starting first, with no userData to bring in, leaves ~/.openlive alone.
    expect(migrateHome(home, { env: {}, homedir: fakeHome })).toBeNull();
    expect(existsSync(join(home, "state", "migration.json"))).toBe(false);

    migrateHome(home, { from: join(userData, "data"), userData, env: {}, homedir: fakeHome });
    expectNewLayout(home, key);
    for (const f of ["window-state.json", "appearance.json", "preferences.json", "once.json", "server-pids.json", "telemetry.json", "telemetry-queue.jsonl", "telemetry-off"]) {
      expect(readFileSync(join(home, "state", f), "utf8")).toBe(f);
    }
    for (const f of ["openlive.db", "openlive.db-wal", "openlive.db-shm"]) expect(readFileSync(join(home, f), "utf8")).toBe(`stray ${f}`);
    expect(readFileSync(join(home, "data", "openlive.db"), "utf8")).toBe('{"f":"openlive.db"}');
    expect(existsSync(join(home, "flow", "config.json")) && existsSync(join(home, "skills", "s", "SKILL.md"))).toBe(true);
    expect(existsSync(join(userData, "Local Storage", "leveldb", "000003.log"))).toBe(true);
    for (const old of [userData, join(userData, "data")]) expect(readFileSync(join(old, "MIGRATED.txt"), "utf8")).toContain(home);
    expect(tree(join(userData, "data"))).toEqual(["MIGRATED.txt", "keep-me.txt"]);
  });

  it("moves the Linux portal token out of XDG state with the installed app's files", () => {
    const fakeHome = temp();
    const xdg = join(fakeHome, "xdg-state");
    put(join(xdg, "openlive", "computer-use", "portal-token"), "remote-desktop abc\n");
    const home = join(fakeHome, ".openlive");
    migrateHome(home, { from: join(fakeHome, "old"), userData: join(fakeHome, "ud"), env: { XDG_STATE_HOME: xdg }, platform: "linux", homedir: fakeHome });
    expect(readFileSync(join(home, "state", "portal-token"), "utf8")).toBe("remote-desktop abc\n");
    expect(existsSync(join(xdg, "openlive", "computer-use", "portal-token"))).toBe(false);
  });

  it("stopped part way, loses nothing, starts fine, and finishes on the next start", () => {
    const home = temp();
    const key = oldDataDir(home);
    // The connectors' secrets cannot be written (a folder is in their way): the move stops there.
    put(join(home, "secrets", "connectors.json", "in-the-way"), "");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(migrateHome(home, { env: {} })).toBeNull();
    expect(err).toHaveBeenCalledOnce();
    expect(existsSync(join(home, "state", "migration.json"))).toBe(false);
    // What moved is in its new place, what did not is still where it was: nothing is gone.
    expect(existsSync(join(home, "data", "openlive.db"))).toBe(true);
    expect(json(join(home, "connectors.json"))).toHaveLength(2);
    expect(existsSync(join(home, "secrets", "backup", "connectors.json"))).toBe(true);
    expect(existsSync(join(home, "mcp.json"))).toBe(false);
    expect(existsSync(join(home, "state", ".migrate.lock"))).toBe(false);

    rmSync(join(home, "secrets", "connectors.json"), { recursive: true });
    expect(migrateHome(home, { env: {} })?.skipped).toEqual([]);
    expectNewLayout(home, key);
  });

  it("deletes a source only when its copy is already in place and the same; a different one is left, and said so", () => {
    const home = temp();
    put(join(home, "models", "a", "w.onnx"), "same");
    put(join(home, "data", "models", "a", "w.onnx"), "same");
    put(join(home, "voices", "v.wav"), "old");
    put(join(home, "data", "voices", "v.wav"), "new");
    const report = migrateHome(home, { env: {} });
    expect(existsSync(join(home, "models"))).toBe(false);
    expect(readFileSync(join(home, "voices", "v.wav"), "utf8")).toBe("old");
    expect(readFileSync(join(home, "data", "voices", "v.wav"), "utf8")).toBe("new");
    expect(report?.skipped).toEqual([`${join(home, "voices")}: ${join(home, "data", "voices")} is already there, so it was left as it is`]);
  });

  it("leaves a settings.json that is not JSON as it is, and moves the rest", () => {
    const home = temp();
    put(join(home, "settings.json"), "{ broken");
    put(join(home, "providers.json"), "[]");
    const report = migrateHome(home, { env: {} });
    expect(readFileSync(join(home, "settings.json"), "utf8")).toBe("{ broken");
    expect(existsSync(join(home, "secrets", "providers.json"))).toBe(true);
    expect(report?.skipped).toEqual([`${join(home, "settings.json")}: not valid JSON, left as it is`]);
  });

  it("takes over a lock a killed process left behind", () => {
    const home = temp();
    put(join(home, "providers.json"), "[]");
    mkdirSync(join(home, "state", ".migrate.lock"), { recursive: true });
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(join(home, "state", ".migrate.lock"), old, old);
    expect(migrateHome(home, { env: {} })?.moved).toHaveLength(1);
    expect(existsSync(join(home, "state", ".migrate.lock"))).toBe(false);
  });
});
