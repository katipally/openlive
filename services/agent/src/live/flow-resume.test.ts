// What "carry on from here" actually hands the brain. A stored session holds
// more than a conversation: state markers, captured context and tool activity
// whose results are long stale. Only the words go back.
import assert from "node:assert";
import { test } from "vitest";
import { transcriptOf } from "./flow-ws.ts";

test("only the said and spoken lines come back, in order", () => {
  const messages = transcriptOf([
    { type: "session_state", state: "active" },
    { type: "message", role: "user", text: "what's this error?" },
    { type: "context", context: { app: "Terminal" } },
    { type: "tool_call", name: "read_screen", args: {} },
    { type: "tool_result", name: "read_screen", isError: false },
    { type: "message", role: "assistant", text: "A Node version mismatch." },
    { type: "session_state", state: "archived" },
  ]);
  assert.deepEqual(messages, [
    { role: "user", text: "what's this error?" },
    { role: "assistant", text: "A Node version mismatch." },
  ]);
});

test("empty and malformed lines are dropped rather than sent as blanks", () => {
  assert.deepEqual(transcriptOf([]), []);
  assert.deepEqual(transcriptOf([
    { type: "message", role: "user", text: "   " },
    { type: "message", role: "user" },
    { type: "message", role: "assistant", text: 7 as unknown as string },
  ]), []);
});

test("an unknown role is read as the user, never as the assistant", () => {
  assert.deepEqual(transcriptOf([{ type: "message", role: "system", text: "hi" }]), [{ role: "user", text: "hi" }]);
});
