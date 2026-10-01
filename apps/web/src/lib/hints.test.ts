import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/uiStore", () => ({ useUi: { getState: () => ({ openSettingsTab: () => {} }) } }));

import { selectHints, type HintInputs } from "./hints";

const base: HintInputs = { phase: "idle", active: false, boundAgent: null, agentMeta: null };
const hint = (over: Partial<HintInputs>) => selectHints({ ...base, ...over })[0];

describe("error hints", () => {
  it("shows nothing without an error", () => {
    expect(selectHints(base)).toEqual([]);
  });

  it("reads the wire code first: an agent that could not start opens Agents settings, whatever the words", () => {
    for (const errorCode of ["agent_start_failed", "agent_start_timeout", "agent_no_output", "agent_stalled", "agent_crashed"] as const) {
      expect(hint({ error: "something unrecognisable", errorCode, boundAgent: "codex" })).toMatchObject({ id: "err-agent", action: { label: "Open Agents settings" } });
    }
  });

  it("sends a refused login to Agents only when the brain is an agent", () => {
    expect(hint({ error: "nope", errorCode: "auth", boundAgent: "codex" })?.id).toBe("err-agent");
    expect(hint({ error: "nope", errorCode: "auth" })?.id).toBe("err");
  });

  it("names a missing folder by its code", () => {
    expect(hint({ error: "unrecognisable", errorCode: "agent_no_folder", boundAgent: "codex" })?.id).toBe("err-folder");
  });

  it("trusts the code over words that say otherwise", () => {
    expect(hint({ error: "codex is not installed", errorCode: "rate_limited", boundAgent: "codex" })?.id).toBe("err");
  });

  it("falls back to the words for a brain that sent no code", () => {
    expect(hint({ error: "Codex is not installed" })?.id).toBe("err-agent");
    expect(hint({ error: "Please sign in first" })?.id).toBe("err-agent");
    expect(hint({ error: "Pick a project folder for Codex" })?.id).toBe("err-folder");
    expect(hint({ error: "Something else" })?.id).toBe("err");
  });
});
