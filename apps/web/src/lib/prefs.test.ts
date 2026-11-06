import { describe, expect, it } from "vitest";
import { cleanSessions, resetOnboarding, useOnboarding } from "./prefs";

describe("resetOnboarding", () => {
  it("starts every first run and tour over, as for someone new", () => {
    useOnboarding.setState({ welcomed: true, flowOnboarded: "1", dictateOnboarded: true, dictateCard: 2, tours: ["home", "flow", "dictate"] });
    resetOnboarding();
    expect(useOnboarding.getState()).toMatchObject({ welcomed: false, flowOnboarded: null, dictateOnboarded: false, dictateCard: 1, tours: [] });
  });
});

describe("cleanSessions", () => {
  it("keeps the model a chat picked and drops what is not text", () => {
    expect(cleanSessions({ "chat:a": { bind: "claude", model: "haiku" }, "chat:b": { model: 7 } })).toEqual({ "chat:a": { bind: "claude", model: "haiku" } });
  });
});
