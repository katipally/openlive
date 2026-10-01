import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { splitResult, useAgentActions } from "./agentActions";

const track = vi.fn();
const stream = (text: string) => vi.fn(async () => new Response(text));

beforeEach(() => {
  track.mockReset();
  useAgentActions.setState({ runs: {} });
  vi.stubGlobal("window", { openlive: { telemetry: { track } } });
});
afterEach(() => vi.unstubAllGlobals());

describe("the result marker", () => {
  it("is split off the log the panel shows", () => {
    expect(splitResult("$ npm i\nadded 1 package\n\n[exit 0]\n[result ok]\n")).toEqual({ log: "$ npm i\nadded 1 package\n\n[exit 0]", result: "ok" });
    expect(splitResult("\n✓ Continues in the terminal window that opened.\n[result terminal_opened]\n").result).toBe("terminal_opened");
  });

  it("knows every code the server can send", () => {
    for (const code of ["ok", "failed", "terminal_opened", "terminal_launch_failed", "npm_eacces", "error"]) expect(splitResult(`x\n[result ${code}]\n`).result).toBe(code);
  });

  it("leaves a log without a closing marker, or with a code the server never sends, as it is", () => {
    for (const log of ["no marker\n", "[result ok] in the middle\nmore\n", "x\n[result signed_in]\n", "x\n[result made_up]\n", ""]) expect(splitResult(log)).toEqual({ log });
  });
});

describe("running an agent action", () => {
  it("reports the closed result and the install step, and keeps the log out of both", async () => {
    vi.stubGlobal("fetch", stream("$ npm install -g @secret/tool /Users/someone/x\nadded 3 packages\n\n[exit 0]\n[result ok]\n"));
    await useAgentActions.getState().run("claude-code", "install");
    expect(track.mock.calls).toEqual([
      ["agent_action_result", { agent_id: "claude-code", action: "install", result: "ok", duration_s: 0 }],
      ["onboarding_step", { step: "first_agent_install_ok" }],
    ]);
    expect(JSON.stringify(track.mock.calls)).not.toMatch(/secret|someone|npm/);
    const run = useAgentActions.getState().runs["claude-code"]!;
    expect(run).toMatchObject({ running: false, result: "ok" });
    expect(run.log).toContain("added 3 packages");
    expect(run.log).not.toContain("[result");
  });

  it("reports a terminal sign-in as opened, not as signed in, and no install step", async () => {
    vi.stubGlobal("fetch", stream("$ osascript\n\n✓ Continues in the terminal window that opened.\n[result terminal_opened]\n"));
    await useAgentActions.getState().run("codex", "login");
    expect(track.mock.calls).toEqual([["agent_action_result", { agent_id: "codex", action: "login", result: "terminal_opened", duration_s: 0 }]]);
    expect(useAgentActions.getState().runs.codex!.result).toBe("terminal_opened");
  });

  it("reports a failed install, and an EACCES one, by its code", async () => {
    vi.stubGlobal("fetch", stream("boom\n[exit 1]\n[result npm_eacces]\n"));
    await useAgentActions.getState().run("codex", "install");
    expect(track.mock.calls.map(([name, p]) => [name, p.result])).toEqual([["agent_action_result", "npm_eacces"]]);
  });

  it("reports an error when the request never gets an answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:3000"); }));
    await useAgentActions.getState().run("cursor", "update");
    expect(track.mock.calls).toEqual([["agent_action_result", { agent_id: "cursor", action: "update", result: "error", duration_s: 0 }]]);
    expect(JSON.stringify(track.mock.calls)).not.toContain("ECONNREFUSED");
    expect(useAgentActions.getState().runs.cursor!.log).toContain("ECONNREFUSED");
  });

  it("reports nothing for an id that is not one of the agents", async () => {
    vi.stubGlobal("fetch", stream("[result ok]\n"));
    await useAgentActions.getState().run("not-an-agent", "install");
    expect(track.mock.calls.filter(([name]) => name === "agent_action_result")).toEqual([]);
  });
});
