import { describe, expect, it } from "vitest";
import type { AgentStatus } from "../api";
import { readyAgent, voiceSetupStep } from "./setup";

const row = (o: Partial<AgentStatus>): AgentStatus => ({
  id: "claude-code", label: "Claude Code", installed: true, credState: "ready", wizard: false, loginCommand: "", canInstall: false, canUninstall: false,
  canLogout: false, canUpdate: false, hidden: false, sessions: "", home: "", ...o,
});

describe("readyAgent", () => {
  it("takes the first agent that is installed and signed in", () => {
    expect(readyAgent([row({ id: "codex", credState: "login_required" }), row({ id: "claude-code" })])?.id).toBe("claude-code");
  });
  it("skips one that is missing, signed out, hidden or unknown to this build", () => {
    expect(readyAgent([row({ installed: false }), row({ credState: "unknown" }), row({ hidden: true }), row({ id: "nope" })])).toBeUndefined();
  });
  it("is nothing while the list is unread", () => {
    expect(readyAgent(undefined)).toBeUndefined();
  });
});

describe("voiceSetupStep", () => {
  const base = { models: "missing" as const, plan: { missing: [], bytes: 1e8 }, downloading: false, failed: false, online: true };
  it("shows no prompt until the weights are read, or when none are needed", () => {
    expect(voiceSetupStep({ ...base, models: "reading" })).toBe("reading");
    expect(voiceSetupStep({ ...base, models: "ready" })).toBe("ready");
  });
  it("asks when weights are missing, with or without a size", () => {
    expect(voiceSetupStep(base)).toBe("ask");
    expect(voiceSetupStep({ ...base, plan: null })).toBe("ask");
  });
  it("says offline before it asks or fails, and downloading before everything", () => {
    expect(voiceSetupStep({ ...base, online: false })).toBe("offline");
    expect(voiceSetupStep({ ...base, online: false, failed: true })).toBe("offline");
    expect(voiceSetupStep({ ...base, failed: true })).toBe("failed");
    expect(voiceSetupStep({ ...base, downloading: true, online: false, models: "reading" })).toBe("downloading");
  });
});
