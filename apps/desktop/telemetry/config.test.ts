import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import { join } from "node:path";
import { CONFIG, tmpDir } from "./rig";

const { loadConfig, isActive } = createRequire(import.meta.url)("./config.cjs");

const write = (body: unknown) => {
  const file = join(tmpDir(), "telemetry-config.json");
  fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
  return file;
};

describe("loadConfig", () => {
  it("reads a stamped config, and normalizes the origin", () => {
    expect(loadConfig(fs, write(CONFIG))).toEqual(CONFIG);
    expect(loadConfig(fs, write({ ...CONFIG, origin: "https://app.example.test/path/" }))?.origin).toBe("https://app.example.test");
  });

  it("is null when there is no file, or it is not a config", () => {
    expect(loadConfig(fs, join(tmpDir(), "missing.json"))).toBeNull();
    for (const body of ["", "{", "null", "[]", "{}", { ...CONFIG, clientId: "" }, { ...CONFIG, clientId: "client-1" }, { ...CONFIG, clientId: `${CONFIG.clientId}0` }, { ...CONFIG, endpoint: 5 }, { endpoint: CONFIG.endpoint, clientId: "x" }]) {
      expect(loadConfig(fs, write(body))).toBeNull();
    }
  });

  it("refuses an address that is not https, except this machine", () => {
    expect(loadConfig(fs, write({ ...CONFIG, endpoint: "http://ingest.example.test" }))).toBeNull();
    expect(loadConfig(fs, write({ ...CONFIG, endpoint: "ftp://ingest.example.test" }))).toBeNull();
    expect(loadConfig(fs, write({ ...CONFIG, endpoint: "not a url" }))).toBeNull();
    expect(loadConfig(fs, write({ ...CONFIG, endpoint: "http://localhost:3333" }))).not.toBeNull();
    expect(loadConfig(fs, write({ ...CONFIG, endpoint: "http://127.0.0.1:3333" }))).not.toBeNull();
  });

  it("refuses a value that could smuggle a header", () => {
    expect(loadConfig(fs, write({ ...CONFIG, clientId: "abc\r\nx-evil: 1" }))).toBeNull();
    expect(loadConfig(fs, write({ ...CONFIG, origin: "https://a.test\n" }))).toBeNull();
  });
});

describe("isActive", () => {
  const on = { isPackaged: true, env: {}, argv: ["/Applications/OpenLive.app/Contents/MacOS/OpenLive"], config: CONFIG };

  it("is on for a packaged, stamped, undisturbed run", () => {
    expect(isActive(on)).toBe(true);
  });

  it("is off in every case the contract lists", () => {
    const off = [
      { ...on, isPackaged: false },
      { ...on, isPackaged: undefined },
      { ...on, config: null },
      { ...on, env: { ELECTRON_DEV: "1" } },
      { ...on, env: { OPENLIVE_TELEMETRY: "0" } },
      { ...on, env: { OPENLIVE_TELEMETRY: "false" } },
      { ...on, env: { DO_NOT_TRACK: "1" } },
      { ...on, env: { DO_NOT_TRACK: "true" } },
      { ...on, env: { OPENLIVE_FLOW_HOME: "/tmp/flow" } },
      { ...on, argv: [...on.argv, "--remote-debugging-port=9333"] },
      { ...on, argv: [...on.argv, "--remote-debugging-pipe"] },
      { ...on, argv: [...on.argv, "--inspect"] },
      { ...on, argv: [...on.argv, "--inspect=9229"] },
      { ...on, argv: [...on.argv, "--inspect-brk"] },
    ];
    off.forEach((deps, i) => expect(isActive(deps), `case ${i}`).toBe(false));
  });

  it("is not switched off by unrelated values of those variables", () => {
    expect(isActive({ ...on, env: { OPENLIVE_TELEMETRY: "1", DO_NOT_TRACK: "0", ELECTRON_DEV: "0", OPENLIVE_FLOW_HOME: "" } })).toBe(true);
  });

  describe("an environment opt-out fails closed", () => {
    const active = (env: Record<string, string | undefined>) => isActive({ ...on, env });

    it.each(["0", "false", "off", "OFF", "False", "no", "disabled", "n", "nope", "2", "-1", " ", " 1", "1 ", "yes"])("OPENLIVE_TELEMETRY=%j turns it off", (value) => {
      expect(active({ OPENLIVE_TELEMETRY: value })).toBe(false);
    });

    it.each([undefined, "", "1", "true", "on", "ON", "True", "tRuE"])("OPENLIVE_TELEMETRY=%j leaves it on", (value) => {
      expect(active({ OPENLIVE_TELEMETRY: value })).toBe(true);
    });

    it.each(["1", "true", "TRUE", "yes", "on", "enabled", "2", " ", "anything"])("DO_NOT_TRACK=%j turns it off", (value) => {
      expect(active({ DO_NOT_TRACK: value })).toBe(false);
    });

    it.each([undefined, "", "0", "false", "FALSE", "False"])("DO_NOT_TRACK=%j leaves it on", (value) => {
      expect(active({ DO_NOT_TRACK: value })).toBe(true);
    });

    it("either variable is enough", () => {
      expect(active({ OPENLIVE_TELEMETRY: "1", DO_NOT_TRACK: "yes" })).toBe(false);
      expect(active({ OPENLIVE_TELEMETRY: "off", DO_NOT_TRACK: "0" })).toBe(false);
    });
  });
});
