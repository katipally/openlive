import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LOG_KEEP, LOG_MAX_BYTES, teeStderr } from "./log";

const write = process.stderr.write;
const dir = mkdtempSync(join(tmpdir(), "ol-log-"));
afterEach(() => { process.stderr.write = write; rmSync(dir, { recursive: true, force: true }); });

it("copies stderr into logs/agent.log, stamped, and rotates it within its cap", () => {
  const seen: string[] = [];
  process.stderr.write = ((c: string) => { seen.push(c); return true; }) as typeof process.stderr.write;
  teeStderr(dir);
  process.stderr.write("[agent] first\nsecond\n");
  expect(seen).toEqual(["[agent] first\nsecond\n"]);
  expect(readFileSync(join(dir, "agent.log"), "utf8")).toMatch(/^\d{4}-\d\d-\d\dT\S+Z \[agent\] first\n\S+Z second\n$/);
  if (process.platform !== "win32") expect(statSync(join(dir, "agent.log")).mode & 0o777).toBe(0o600);

  const mb = `${"x".repeat(1024 * 1024 - 1)}\n`;
  for (let i = 0; i < 4 * (LOG_KEEP + 2); i++) process.stderr.write(mb);
  for (const f of ["agent.log", ...Array.from({ length: LOG_KEEP }, (_, i) => `agent.log.${i + 1}`)]) {
    expect(statSync(join(dir, f)).size, f).toBeLessThanOrEqual(LOG_MAX_BYTES);
  }
  expect(existsSync(join(dir, `agent.log.${LOG_KEEP + 1}`))).toBe(false);
});
