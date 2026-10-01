import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
// Windows checks text out with CRLF.
const text = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const read = (rel: string) => text(join(here, rel));
const schema = require("./telemetry/schema.json");
const { stamp } = require("./scripts/pack-telemetry.cjs");

/** The entries under electron-builder.yml's top-level `files:`, comments and blank lines skipped. */
function packagedFiles(): Set<string> {
  const lines = read("electron-builder.yml").split("\n");
  const start = lines.findIndex((l) => l === "files:");
  const entries = new Set<string>();
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const m = /^\s+-\s+(\S+)\s*$/.exec(line);
    if (m) entries.add(m[1]);
  }
  return entries;
}

describe("electron-builder files", () => {
  const files = packagedFiles();

  it("lists every runtime file of telemetry/ and its schema, and no test", () => {
    const runtime = readdirSync(join(here, "telemetry")).filter((f) => f.endsWith(".cjs") || f === "schema.json");
    expect(runtime.length).toBeGreaterThan(8);
    for (const f of runtime) expect(files, `telemetry/${f}`).toContain(`telemetry/${f}`);
    expect([...files].filter((f) => f.startsWith("telemetry/") && /\.test\.|rig\./.test(f))).toEqual([]);
  });

  it("lists every file main and the preload load, however deep", () => {
    const seen = new Set<string>();
    const queue = ["main.cjs", "preload.cjs"];
    while (queue.length) {
      const rel = queue.pop()!;
      if (seen.has(rel)) continue;
      seen.add(rel);
      if (!/\.cjs$/.test(rel)) continue;
      const code = read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      for (const m of code.matchAll(/require\("(\.[^"]+)"\)/g)) {
        queue.push(relative(here, resolve(here, dirname(rel), m[1])).replace(/\\/g, "/"));
      }
    }
    expect(seen.size).toBeGreaterThan(10);
    const missing = [...seen].filter((f) => !files.has(f));
    expect(missing).toEqual([]);
  });

  it("packs the stamped config when there is one", () => {
    expect(files).toContain("telemetry-config.json");
  });

  it("ships the paths module main loads from the resources, with every file it imports", () => {
    expect(read("main.cjs")).toContain(`path.join(process.resourcesPath, "home", "index.mjs")`);
    expect(read("electron-builder.yml")).toMatch(/- from: \.\.\/\.\.\/packages\/shared\/src\/home\n\s+to: home\n\s+filter: \["\*\.mjs"\]/);
    const homeDir = join(here, "..", "..", "packages", "shared", "src", "home");
    const imports = [...text(join(homeDir, "index.mjs")).matchAll(/from "(\.[^"]+)"/g)].map((m) => m[1]!);
    for (const f of imports) expect(existsSync(join(homeDir, f)), f).toBe(true);
    expect(imports.every((f) => f.endsWith(".mjs"))).toBe(true);
  });
});

describe("the computer-use helper", () => {
  it("ships where Electron main tells the agent to find it, on macOS, Windows and Linux", () => {
    const builder = read("electron-builder.yml");
    const main = read("main.cjs");
    expect(builder).toMatch(/- from: "dist\/computer-use\/OpenLive Computer Use.app"\n\s+to: "OpenLive Computer Use.app"/);
    expect(main).toContain(`path.join(process.resourcesPath, "OpenLive Computer Use.app", "Contents", "MacOS", "openlive-cu")`);
    expect(builder).toMatch(/- from: dist\/computer-use\/openlive-cu.exe\n\s+to: openlive-cu.exe/);
    expect(main).toContain(`process.platform === "win32" && { OPENLIVE_CU_HELPER: path.join(process.resourcesPath, "openlive-cu.exe") }`);
    expect(read("scripts/check-native.cjs")).toContain(`win32: path.join(staged, "openlive-cu.exe")`);
    expect(builder).toMatch(/- from: dist\/computer-use\/openlive-cu\n\s+to: openlive-cu\n/);
    expect(main).toContain(`process.platform === "linux" && { OPENLIVE_CU_HELPER: path.join(process.resourcesPath, "openlive-cu") }`);
    expect(read("scripts/check-native.cjs")).toContain(`linux: path.join(staged, "openlive-cu")`);
  });

  it("is let to the front by main, which answers the agent's request by the same name", () => {
    const main = read("main.cjs");
    const agent = text(join(here, "..", "..", "services", "agent", "src", "computer", "helper.ts"));
    expect(main).toContain(`msg?.openlive === "allow-foreground"`);
    expect(main).toContain(`flowInput.load().allowSetForegroundWindow(pid)`);
    expect(main).toContain(`child.postMessage({ openlive: "allow-foreground", id })`);
    expect(agent).toContain(`port.postMessage({ openlive: "allow-foreground", id, pid })`);
    expect(read("../../native/ol-input/index.d.ts")).toContain("export function allowSetForegroundWindow(pid: number): boolean;");
  });
});

describe("timers and reminders", () => {
  it("are shown by main as the agent sends them, by the same message name", () => {
    const main = read("main.cjs");
    const agent = text(join(here, "..", "..", "services", "agent", "src", "reminders", "fire.ts"));
    expect(main).toContain(`msg?.openlive === "notify"`);
    expect(agent).toContain(`port?.postMessage({ openlive: "notify", title: m.title, body: m.body })`);
  });
});

describe("hook sites", () => {
  const source = ["main.cjs", "flow-input.cjs", "flow-runtime.cjs"].map(read).join("\n");
  const all = (re: RegExp) => [...source.matchAll(re)].map((m) => m[1]);

  it("send only events the schema has", () => {
    const names = all(/telemetry\.track\("([a-z_]+)"/g);
    expect(names.length).toBeGreaterThan(8);
    for (const name of names) expect(Object.keys(schema.events), name).toContain(name);
  });

  it("report only onboarding steps and active-day surfaces the schema lists", () => {
    const steps = all(/reportOnboardingStep\("([a-z_]+)"\)/g);
    expect(steps.sort()).toEqual(["first_call", "first_device_action", "first_flow_summon", "flow_hook_failed", "flow_hook_started"]);
    for (const step of steps) expect(schema.events.onboarding_step.props.step.values, step).toContain(step);
    const surfaces = all(/markActiveDay\("([a-z_]+)"\)/g);
    expect(new Set(surfaces)).toEqual(new Set(schema.events.app_active_day.props.first_surface.values));
  });

  it("change only settings and tray actions the schema lists", () => {
    for (const setting of all(/trackSetting\("([a-z_]+)"/g)) expect(Object.keys(schema.settings), setting).toContain(setting);
    for (const action of all(/fromTray\("([a-z_]+)"/g)) expect(schema.events.tray_action.props.action.values, action).toContain(action);
    expect(new Set(all(/fromTray\("([a-z_]+)"/g))).toEqual(new Set(schema.events.tray_action.props.action.values));
  });

  it("close records with reasons the schema lists", () => {
    for (const reason of all(/closeFlow\("([a-z_]+)"\)/g)) expect(schema.events.flow_session.props.ended_by.values).toContain(reason);
    for (const reason of all(/closeCall\("([a-z_]+)"\)/g)) expect(schema.events.call_session.props.ended_by.values).toContain(reason);
    for (const via of all(/(?:quitApp|onQuit)\("([a-z_]+)"\)/g)) expect(schema.events.app_quit.props.via.values, via).toContain(via);
  });
});

describe("pack-telemetry", () => {
  const dirs: string[] = [];
  const target = () => {
    const dir = mkdtempSync(join(tmpdir(), "openlive-pack-telemetry-"));
    dirs.push(dir);
    return join(dir, "telemetry-config.json");
  };
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  const vars = {
    OPENLIVE_TELEMETRY_ENDPOINT: "https://ingest.example.test",
    OPENLIVE_TELEMETRY_CLIENT_ID: "11111111-2222-4333-8444-555555555555",
    OPENLIVE_TELEMETRY_ORIGIN: "https://app.example.test",
  };

  it("writes the three values the sender reads", () => {
    const file = target();
    expect(stamp(vars, file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ endpoint: "https://ingest.example.test", clientId: "11111111-2222-4333-8444-555555555555", origin: "https://app.example.test" });
  });

  it("writes nothing when any variable is unset or blank", () => {
    for (const name of Object.keys(vars)) {
      const file = target();
      expect(stamp({ ...vars, [name]: "" }, file)).toBe(false);
      expect(existsSync(file)).toBe(false);
      expect(stamp({ ...vars, [name]: undefined }, file)).toBe(false);
      expect(existsSync(file)).toBe(false);
    }
    expect(stamp({}, target())).toBe(false);
  });

  it("removes a stale file when it stamps nothing", () => {
    const file = target();
    stamp(vars, file);
    expect(existsSync(file)).toBe(true);
    expect(stamp({ ...vars, OPENLIVE_TELEMETRY_CLIENT_ID: undefined }, file)).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it("refuses values the sender would refuse, and leaves no file behind", () => {
    const file = target();
    expect(() => stamp({ ...vars, OPENLIVE_TELEMETRY_ENDPOINT: "http://ingest.example.test" }, file)).toThrow(/not usable/);
    expect(existsSync(file)).toBe(false);
    expect(() => stamp({ ...vars, OPENLIVE_TELEMETRY_ORIGIN: "not a url" }, file)).toThrow(/not usable/);
    expect(existsSync(file)).toBe(false);
  });

  it("refuses a client ID that is not a UUID, since the server would answer 401 to it forever", () => {
    for (const bad of ["client-1", "11111111-2222-4333-8444-55555555555", "11111111-2222-4333-8444-5555555555555", " 11111111-2222-4333-8444-555555555555x"]) {
      const file = target();
      expect(() => stamp({ ...vars, OPENLIVE_TELEMETRY_CLIENT_ID: bad }, file)).toThrow(/client ID a UUID/);
      expect(existsSync(file)).toBe(false);
    }
  });

  it("never prints or throws a value", () => {
    const secret = "client-secret-value-123";
    for (const env of [
      { ...vars, OPENLIVE_TELEMETRY_CLIENT_ID: secret },
      { ...vars, OPENLIVE_TELEMETRY_CLIENT_ID: secret, OPENLIVE_TELEMETRY_ENDPOINT: "http://x.test" },
    ]) {
      let message = "";
      try {
        stamp(env, target());
      } catch (e) {
        message = String((e as Error).message);
      }
      expect(message).toMatch(/not usable/);
      expect(message).not.toContain(secret);
      expect(message).not.toContain("x.test");
    }
  });

  it("runs in `pack`, and the file it writes stays out of git", () => {
    const scripts = JSON.parse(read("package.json")).scripts;
    expect(scripts["pack:telemetry"]).toContain("pack-telemetry.cjs");
    expect(scripts.pack).toContain("pack-telemetry.cjs");
    expect(text(join(here, "..", "..", ".gitignore")).split("\n")).toContain("apps/desktop/telemetry-config.json");
  });
});
