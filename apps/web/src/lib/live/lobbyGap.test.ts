import { describe, expect, it } from "vitest";
import { heldGap, HELD_MS, lobbyGap, offerStep, type LobbyState } from "./lobbyGap";

const clear: LobbyState = { modelsMissing: false, agentGap: null, needFolder: false, folderGap: false, keyGap: false, micGap: false };
const gap = (over: Partial<LobbyState>) => lobbyGap({ ...clear, ...over });

describe("lobby gap", () => {
  it("is none when nothing stops the call", () => {
    expect(gap({})).toBeNull();
  });

  it("names each gap the lobby can show", () => {
    expect(gap({ modelsMissing: true })).toBe("models_not_downloaded");
    expect(gap({ agentGap: "install" })).toBe("agent_not_installed");
    expect(gap({ agentGap: "signin" })).toBe("agent_signed_out");
    expect(gap({ needFolder: true })).toBe("folder_unset");
    expect(gap({ folderGap: true })).toBe("folder_missing");
    expect(gap({ keyGap: true })).toBe("no_api_key");
    expect(gap({ micGap: true })).toBe("no_mic");
  });

  it("puts first the one the lobby shows first, and what disables Start before the download", () => {
    const all = { agentGap: "signin", needFolder: true, folderGap: true, keyGap: true, micGap: true } as const;
    expect(gap({ ...all, modelsMissing: true })).toBe("agent_signed_out");
    expect(gap({ needFolder: true, folderGap: true, keyGap: true, micGap: true })).toBe("folder_unset");
    expect(gap({ folderGap: true, keyGap: true, micGap: true })).toBe("folder_missing");
    expect(gap({ keyGap: true, micGap: true, modelsMissing: true })).toBe("no_api_key");
    expect(gap({ micGap: true, modelsMissing: true })).toBe("models_not_downloaded");
  });
});

describe("download offer", () => {
  const plan = (bytes: number | null) => ({ missing: [{ key: "stt" as const, repo: "r", path: "p" }], bytes });
  const step = (over: Partial<Parameters<typeof offerStep>[0]>) =>
    offerStep({ open: true, plan: plan(1e8), downloading: false, failed: false, online: true, ...over });

  it("shows nothing until Start opens it", () => {
    expect(step({ open: false })).toBeNull();
  });

  it("checks, then asks with the size it read", () => {
    expect(step({ plan: null })).toBe("checking");
    expect(step({})).toBe("ask");
  });

  it("still asks online when the size could not be read, and says offline instead of asking", () => {
    expect(step({ plan: plan(null) })).toBe("ask");
    expect(step({ online: false })).toBe("offline");
    expect(step({ plan: null, online: false })).toBe("offline");
  });

  it("shows progress once agreed to, then a failure that can be tried again", () => {
    expect(step({ downloading: true })).toBe("downloading");
    expect(step({ failed: true })).toBe("failed");
    expect(step({ failed: true, online: false })).toBe("offline");
  });
});

describe("held gap", () => {
  it("counts a gap only after it has been up for a second", () => {
    expect(heldGap({ gap: "no_mic", since: 5000 }, 5000 + HELD_MS - 1)).toBeNull();
    expect(heldGap({ gap: "no_mic", since: 5000 }, 5000 + HELD_MS)).toBe("no_mic");
  });

  it("is none when no gap is showing, however long", () => {
    expect(heldGap({ gap: null, since: 0 }, 1e9)).toBeNull();
  });
});
