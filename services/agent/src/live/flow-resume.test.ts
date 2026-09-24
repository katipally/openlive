// What "carry on from here" actually hands the brain. A stored session holds
// more than a conversation: state markers, captured context and tool activity
// whose results are long stale. Only the words go back.
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { FlowSession, loadSession } from "@openlive/flow-store";
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

test("a resumed session remembers only what was heard of a reply cut off after it was written", async () => {
  const home = mkdtempSync(join(tmpdir(), "flow-resume-"));
  process.env.OPENLIVE_FLOW_HOME = home;
  try {
    const s = await FlowSession.open();
    await s.append("message", { role: "user", text: "count to three" });
    const reply = await s.append("message", { role: "assistant", text: "One. Two. Three." });
    await s.append("cut", { target: reply.id, text: "One." });
    await s.append("message", { role: "user", text: "what's next?" });
    const unheard = await s.append("message", { role: "assistant", text: "Four." });
    await s.append("cut", { target: unheard.id, text: "" });
    await s.archive();
    assert.deepEqual(transcriptOf(loadSession(s.id)!.entries), [
      { role: "user", text: "count to three" },
      { role: "assistant", text: "One." },
      { role: "user", text: "what's next?" },
    ]);
  } finally {
    delete process.env.OPENLIVE_FLOW_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});
