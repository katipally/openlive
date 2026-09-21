import { describe, expect, it } from "vitest";
import { truncateToSpoken } from "./flow-ws.js";
import type { Msg } from "../flow/types.js";

// Barge-in persists what the user HEARD, not what the model had already written
// ahead of the voice. Everything else about the turn stays exactly as it was.

describe("truncateToSpoken", () => {
  it("cuts the last assistant reply back to what was voiced", () => {
    const messages: Msg[] = [
      { role: "user", text: "explain this" },
      { role: "assistant", text: "It is a version mismatch and you should upgrade Node to 20." },
    ];
    truncateToSpoken(messages, "It is a version mismatch");
    expect(messages[1]).toEqual({ role: "assistant", text: "It is a version mismatch" });
  });

  it("drops a reply the user cut off before a single word of it played", () => {
    const messages: Msg[] = [{ role: "user", text: "hi" }, { role: "assistant", text: "Hello there" }];
    truncateToSpoken(messages, "");
    expect(messages).toHaveLength(1);
  });

  it("keeps an aborted tool call even with nothing spoken", () => {
    const messages: Msg[] = [
      { role: "user", text: "type it" },
      { role: "assistant", toolCalls: [{ id: "1", name: "insert_text", arguments: "{}" }] },
    ];
    truncateToSpoken(messages, "");
    expect(messages).toHaveLength(2);
    expect(messages[1]!.role).toBe("assistant");
  });

  it("leaves a transcript with no assistant reply alone", () => {
    const messages: Msg[] = [{ role: "user", text: "hi" }];
    truncateToSpoken(messages, "anything");
    expect(messages).toEqual([{ role: "user", text: "hi" }]);
  });
});
