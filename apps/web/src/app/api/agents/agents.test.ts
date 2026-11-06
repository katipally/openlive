import { describe, expect, it } from "vitest";
import { AGENT_REGISTRY } from "@openlive/shared";
import { actionCommand, installDisplay, installHint } from "./agents";

describe("install hints", () => {
  it("name the admin need of Kiro's MSI on Windows", () => {
    expect(installHint("Installation failed with exit code 1925", true)).toMatch(/administrator/);
  });

  it("name a missing npm on Windows, and stay quiet elsewhere or when nothing is known", () => {
    expect(installHint("'npm' is not recognized as an internal or external command", true)).toMatch(/Node\.js/);
    expect(installHint("exit code 1925", false)).toBeNull();
    expect(installHint("something else broke", true)).toBeNull();
  });
});

describe("install command shown to the person", () => {
  it("is the npm line, or the platform's shell recipe", () => {
    expect(installDisplay(AGENT_REGISTRY.codex, true)).toBe("npm install -g @openai/codex");
    expect(installDisplay(AGENT_REGISTRY.cursor, false)).toBe("curl https://cursor.com/install -fsS | bash");
    expect(installDisplay(AGENT_REGISTRY.cursor, true)).toContain("install?win32=true");
  });
});

describe("Cursor on Windows", () => {
  it("fetches the Windows script, not the bash one", () => {
    const shell = AGENT_REGISTRY.cursor.install?.winShell ?? "";
    expect(shell).toBe("irm 'https://cursor.com/install?win32=true' | iex");
    if (process.platform === "win32") expect(actionCommand(AGENT_REGISTRY.cursor, "install")?.args).toContain(shell);
  });
});
