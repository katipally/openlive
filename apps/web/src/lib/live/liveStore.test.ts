import { describe, it, expect } from "vitest";
import { useLiveStore } from "./liveStore";

// Guards the 1C re-render fix: components pick narrow slices with useShallow,
// so a hot caption tick must not disturb the fields the chrome subscribes to.
describe("liveStore slice stability", () => {
  it("caption updates leave unrelated fields referentially identical", () => {
    const before = useLiveStore.getState();
    const pick = (s: typeof before) => ({ muted: s.muted, cameraOn: s.cameraOn, mics: s.mics, phase: s.phase });
    const a = pick(before);

    useLiveStore.getState().set({ agentCaption: "streaming words", agentCaptionMs: 1200 });
    useLiveStore.getState().set({ toolStatus: "web_search" });

    const b = pick(useLiveStore.getState());
    expect(b.mics).toBe(a.mics);       // same array reference — no spurious re-render
    expect(b.muted).toBe(a.muted);
    expect(b.cameraOn).toBe(a.cameraOn);
    expect(b.phase).toBe(a.phase);
    expect(useLiveStore.getState().agentCaption).toBe("streaming words");
  });
});
