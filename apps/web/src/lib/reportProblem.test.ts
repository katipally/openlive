import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { noteLastFailure, reportProblem, reportProblemUrl } from "./reportProblem";

const body = (url: string) => new URL(url).searchParams.get("body")!;
const environment = (url: string) => body(url).split("**Environment**\n")[1]!.split("\n\n")[0]!;
const TEMPLATE = readFileSync(join(import.meta.dirname, "../../../../.github/ISSUE_TEMPLATE/bug_report.md"), "utf8");

afterEach(() => {
  noteLastFailure("");
  vi.unstubAllGlobals();
});

describe("report a problem", () => {
  it("keeps every heading of the bug template", () => {
    const headings = [...TEMPLATE.matchAll(/^\*\*(.+)\*\*$/gm)].map((m) => m[0]);
    expect(headings.length).toBeGreaterThan(3);
    for (const h of headings) expect(body(reportProblemUrl())).toContain(h);
  });

  it("fills the environment from closed fields", () => {
    noteLastFailure("mic_failed");
    const url = reportProblemUrl({ appVersion: "0.2.0", osName: "macOS", osMajor: "15", brainId: "claude-code" });
    expect(url.startsWith("https://github.com/katipally/openlive/issues/new?labels=bug&body=")).toBe(true);
    expect(environment(url)).toBe([
      "- OS and version: macOS 15",
      "- OpenLive version: 0.2.0",
      "- Model provider: claude-code",
      "- Last failure: mic_failed",
    ].join("\n"));
  });

  it("leaves a field empty rather than send a value outside its set", () => {
    noteLastFailure("cannot open /Users/someone/private.txt");
    const url = reportProblemUrl({
      appVersion: "0.2.0\nsecret", osName: "Ubuntu 24.04 of someone", osMajor: "15 and my name", brainId: "my-own-model-name",
    });
    expect(environment(url)).toBe(["- OS and version: ", "- OpenLive version: ", "- Model provider: "].join("\n"));
    expect(url).not.toMatch(/secret|someone|private|Ubuntu/);
  });

  it("accepts a dev build's version and Linux's bare name", () => {
    expect(environment(reportProblemUrl({ appVersion: "0.2.0-dev", osName: "Linux", osMajor: "linux" }))).toContain("- OS and version: Linux\n- OpenLive version: 0.2.0-dev");
  });

  it("stays well under GitHub's address limit even with every field filled", () => {
    noteLastFailure("no_accessibility");
    const url = reportProblemUrl({ appVersion: "12.345.6789-rc.1.alpha.2", osName: "Windows", osMajor: "11", brainId: "ollama-cloud" });
    expect(url.length).toBeLessThan(1000);
    expect(reportProblemUrl().length).toBeLessThan(1000);
  });

  it("forgets a failure that is not one of the closed codes", () => {
    noteLastFailure("turn_failed");
    noteLastFailure("nope");
    expect(environment(reportProblemUrl())).not.toContain("Last failure");
  });

  it("opens the report with what the shell knows, and without a shell too", async () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open, openlive: { telemetry: { get: async () => ({ appVersion: "1.0.0", osName: "Windows", osMajor: "11", enabled: true, active: true, noticeSeen: true, installIdTail: "abcd" }) } } });
    await reportProblem("codex");
    expect(open).toHaveBeenCalledOnce();
    const [url, target, features] = open.mock.calls[0]!;
    expect(environment(url)).toBe("- OS and version: Windows 11\n- OpenLive version: 1.0.0\n- Model provider: codex");
    expect([target, features]).toEqual(["_blank", "noopener"]);
    expect(url).not.toContain("abcd");

    open.mockClear();
    vi.stubGlobal("window", { open });
    await reportProblem();
    expect(environment(open.mock.calls[0]![0])).toBe("- OS and version: \n- OpenLive version: \n- Model provider: ");
  });
});
