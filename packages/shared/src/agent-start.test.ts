import { describe, expect, it } from "vitest";
import { AgentStartError, startFailure, startMessage, startReason, startReasonOf, START_REASONS } from "./agent-start";
import { telemetrySchema } from "./telemetry-schema";

describe("startReason", () => {
  it.each([
    ["This client is no longer supported for Gemini Code Assist for individuals.\nTo continue using Gemini, please migrate to the Antigravity suite of products.", null, "personal_account"],
    ["Eligibility check failed: PERMISSION_DENIED (code 403)", 1, "personal_account"],
    ["You must be a named user on your organization's Gemini Code Assist Standard edition subscription", 1, "personal_account"],
    ["Error: not logged in. Run opencode auth login", 1, "auth_needed"],
    ["Please set an Auth method in your settings.json", 1, "auth_needed"],
    ["Error: no provider configured", 1, "auth_needed"],
    ["zsh: command not found: hermes", 127, "not_installed"],
    ["", 127, "not_installed"],
    ["'gemini' is not recognized as an internal or external command", 1, "not_installed"],
    ["Unknown argument: acp", 1, "outdated"],
    ["unrecognized option '--acp'", 2, "outdated"],
    ["Segmentation fault", 139, "exited"],
    ["", 3, "exited"],
    ["", null, "exited"],
  ])("%j with code %s is %s", (text, code, reason) => {
    expect(startReason(text, code)).toBe(reason);
  });

  it("reads a refused personal account before a generic sign-in line", () => {
    expect(startReason("Failed to sign in. not logged in. This client is no longer supported for Gemini Code Assist for individuals")).toBe("personal_account");
  });
});

describe("startMessage", () => {
  it("names the real sign-in command per agent", () => {
    expect(startMessage("opencode", "auth_needed")).toContain("`opencode auth login`");
    expect(startMessage("hermes", "auth_needed")).toContain("`hermes setup`");
    expect(startMessage("gemini", "auth_needed")).toContain("`gemini`");
  });

  it("points a missing binary at Settings, and a missing npx at Node.js", () => {
    expect(startMessage("gemini", "not_installed", { command: "gemini" })).toBe("Gemini CLI isn't installed. Install it from Settings → Agents, then retry.");
    expect(startMessage("codex", "not_installed", { command: "npx" })).toContain("Node.js");
  });

  it("tells a personal Gemini account to use an API key", () => {
    const m = startMessage("gemini", "personal_account");
    expect(m).toContain("GEMINI_API_KEY");
    expect(m).toContain("aistudio.google.com/apikey");
  });

  it("says how long a timeout waited", () => {
    expect(startMessage("hermes", "timeout", { seconds: 15 })).toContain("15s");
  });

  it("keeps the exit code and the agent's last words for an unexplained exit", () => {
    expect(startMessage("opencode", "exited", { code: 3, tail: "— boom" })).toMatch(/^OpenCode exited before connecting \(code 3\)\..*— boom$/);
  });
});

describe("startFailure", () => {
  it("carries the reason, and the timeout its own class", () => {
    const e = startFailure("gemini", "timeout", { seconds: 1 });
    expect(e).toBeInstanceOf(AgentStartError);
    expect(startReasonOf(e)).toBe("timeout");
    expect(e.errorClass).toBe("agent_start_timeout");
    expect(startFailure("gemini", "auth_needed").errorClass).toBe("agent_start_failed");
    expect(startReasonOf(new Error("x"))).toBeUndefined();
  });

  it("uses reasons the telemetry schema accepts", () => {
    expect(telemetrySchema.events.brain_error.props.start_reason.values.slice().sort()).toEqual([...START_REASONS].sort());
  });
});
