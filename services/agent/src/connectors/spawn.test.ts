import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { stdioParams } from "./spawn.js";

const t = (over: Partial<Parameters<typeof stdioParams>[0]> = {}) => ({ command: "npx", args: ["-y", "srv"], env: {}, ...over });

describe("a stdio connector's spawn", () => {
  it("gets the user's widened PATH on macOS and Linux, where a GUI launch has almost none", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const p = stdioParams(t(), {}, platform, () => "/opt/homebrew/bin:/usr/bin");
      expect(p.env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
      expect(p).toMatchObject({ command: "npx", args: ["-y", "srv"] });
    }
  });

  it("keeps a PATH the user set ahead of the widened one, joined the platform's way", () => {
    expect(stdioParams(t({ env: { PATH: "/mine" } }), {}, "linux", () => "/usr/bin").env.PATH).toBe("/mine:/usr/bin");
    // Windows spells it Path; cross-spawn resolves npx.cmd against PATH, so it is folded in once.
    const win = stdioParams(t({ env: { Path: "C:\\mine" } }), {}, "win32", () => "C:\\Windows");
    expect(win.env.PATH).toBe("C:\\mine;C:\\Windows");
    expect(win.env).not.toHaveProperty("Path");
  });

  it("passes the command through bare on Windows, for cross-spawn to find the .cmd shim", () => {
    expect(stdioParams(t({ command: "uvx" }), {}, "win32", () => "C:\\bin").command).toBe("uvx");
  });

  it("merges secret env over plain env and expands ~ in the command and folder", () => {
    const p = stdioParams(t({ command: "~/bin/srv", cwd: "~/proj", env: { A: "1", K: "plain" } }), { K: "secret" }, "linux", () => "/usr/bin");
    expect(p.env).toMatchObject({ A: "1", K: "secret" });
    expect(p.command.startsWith(homedir())).toBe(true);
    expect(p.cwd!.startsWith(homedir())).toBe(true);
  });
});
