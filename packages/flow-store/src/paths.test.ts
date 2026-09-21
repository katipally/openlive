import { statSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { assetsDir, configPath, ensureDir, flowDir, flowHome, sessionAssetsDir, sessionsDir } from "./paths";

const dir = mkdtempSync(join(tmpdir(), "flow-paths-"));
afterAll(() => { delete process.env.OPENLIVE_FLOW_HOME; rmSync(dir, { recursive: true, force: true }); });

test("falls back to ~/.openlive on every platform", () => {
  delete process.env.OPENLIVE_FLOW_HOME;
  expect(flowHome()).toBe(join(homedir(), ".openlive"));
  expect(flowDir()).toBe(join(homedir(), ".openlive", "flow"));
});

test("OPENLIVE_FLOW_HOME is read per call, not at import", () => {
  process.env.OPENLIVE_FLOW_HOME = dir;
  expect(configPath()).toBe(join(dir, "flow", "config.json"));
  expect(sessionsDir()).toBe(join(dir, "flow", "sessions"));
  expect(sessionAssetsDir("abc")).toBe(join(assetsDir(), "abc"));
});

test("ensureDir creates lazily and keeps the store private", () => {
  process.env.OPENLIVE_FLOW_HOME = dir;
  const made = ensureDir(sessionAssetsDir("s1"));
  const st = statSync(made);
  expect(st.isDirectory()).toBe(true);
  if (process.platform !== "win32") expect(st.mode & 0o777).toBe(0o700);
  ensureDir(made); // idempotent
});
