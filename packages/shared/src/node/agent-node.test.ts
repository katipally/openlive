import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminalCommand } from "./agent-node";

const realPlatform = process.platform;
const realPath = process.env.PATH;
const as = (p: NodeJS.Platform) => Object.defineProperty(process, "platform", { value: p, configurable: true });
afterEach(() => { as(realPlatform); process.env.PATH = realPath; });

// Sign-in/setup flows need a TTY and a browser, so every platform must produce a
// VISIBLE terminal window — a headless `bash -lc` leaves the user staring at nothing.
// The Linux cases probe PATH on disk, which under a full parallel run can outlast the 5 s default.
describe("terminalCommand", { timeout: 20_000 }, () => {
  it("opens Terminal.app on macOS", () => {
    as("darwin");
    expect(terminalCommand("claude auth login").cmd).toBe("osascript");
  });

  it("opens a new PowerShell window on Windows", () => {
    as("win32");
    const { cmd, args } = terminalCommand("codex login");
    expect(cmd).toBe("cmd");
    expect(args).toContain("start");
    expect(args).toContain("-NoExit");
  });

  it("still names a terminal on Linux when none is installed, so the caller can surface guidance", () => {
    as("linux");
    process.env.PATH = mkdtempSync(join(tmpdir(), "ol-empty-"));
    const { cmd } = terminalCommand("hermes setup");
    expect(cmd).toBe("x-terminal-emulator");
  });

  it("picks the emulator that is actually installed on Linux", () => {
    const dir = mkdtempSync(join(tmpdir(), "ol-term-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "konsole"), "");
    as("linux");
    process.env.PATH = dir;
    const { cmd, args } = terminalCommand("opencode auth login");
    expect(cmd).toBe("konsole");
    // "-e" then a login shell that stays open so the user can read the result.
    expect(args).toEqual(["-e", "bash", "-lc", "opencode auth login; exec bash"]);
  });
});
