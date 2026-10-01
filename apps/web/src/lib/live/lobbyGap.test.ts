import { describe, expect, it } from "vitest";
import { heldGap, HELD_MS, lobbyGap, type LobbyState } from "./lobbyGap";

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

  it("puts first the one the lobby shows first, and the download offer above all", () => {
    const all = { agentGap: "signin", needFolder: true, folderGap: true, keyGap: true, micGap: true } as const;
    expect(gap({ ...all, modelsMissing: true })).toBe("models_not_downloaded");
    expect(gap(all)).toBe("agent_signed_out");
    expect(gap({ needFolder: true, folderGap: true, keyGap: true, micGap: true })).toBe("folder_unset");
    expect(gap({ folderGap: true, keyGap: true, micGap: true })).toBe("folder_missing");
    expect(gap({ keyGap: true, micGap: true })).toBe("no_api_key");
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
