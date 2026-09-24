// What "carry on from here" actually hands the brain. A stored session holds
// more than a conversation: state markers, captured context and tool activity
// whose results are long stale. Only the words go back.
import assert from "node:assert";
import { test } from "vitest";
import { priorTurns, transcriptOf } from "./flow-ws.ts";

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

test("a coding agent is seeded with what came before the words it is about to be sent", () => {
  const said = [
    { role: "user" as const, text: "open the PR" },
    { role: "assistant" as const, text: "Opened." },
    { role: "user" as const, text: "now approve it" },
    { role: "user" as const, text: "actually, the other one" },
  ];
  assert.deepEqual(priorTurns(said), said.slice(0, 2));
  assert.deepEqual(priorTurns(said.slice(2)), []);
});
