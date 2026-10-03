import { describe, expect, it } from "vitest";
import { parseFlowConfig } from "@openlive/flow-store";
import { settleTalkMode } from "./talk";

describe("how you talk, after the move from Chat's own switch", () => {
  const moved = parseFlowConfig({ version: 8 });

  it("is push to talk for whoever had Chat's push to talk on, and hands-free for everyone else", () => {
    expect(settleTalkMode(moved, true)).toBe("ptt");
    expect(settleTalkMode(moved, false)).toBe("handsFree");
  });

  it("is left alone once decided, so a later pick is never undone", () => {
    expect(settleTalkMode(parseFlowConfig({}), true)).toBeNull();
    expect(settleTalkMode(parseFlowConfig({ talk: { mode: "ptt" } }), false)).toBeNull();
  });
});
