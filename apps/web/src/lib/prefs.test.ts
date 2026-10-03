import { describe, expect, it } from "vitest";
import { resetOnboarding, useOnboarding } from "./prefs";

describe("resetOnboarding", () => {
  it("starts every first run and tour over, as for someone new", () => {
    useOnboarding.setState({ welcomed: true, flowOnboarded: "1", dictateOnboarded: true, tours: ["home", "flow", "dictate"] });
    resetOnboarding();
    expect(useOnboarding.getState()).toMatchObject({ welcomed: false, flowOnboarded: null, dictateOnboarded: false, tours: [] });
  });
});
