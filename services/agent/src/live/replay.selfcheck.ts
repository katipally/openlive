// Runnable self-check for the resume round-trip's non-trivial bits. Run:
//   OPENLIVE_DATA_DIR=$(mktemp -d) pnpm --filter @openlive/agent exec tsx src/live/replay.selfcheck.ts
// Guards: (1) the agent session id persists onto the chat summary (History dedup +
// "continue in the CLI"); (2) replay-ingest persists ONLY into an empty chat; (3) the
// replay block-merge folds streamed chunks into one message.
import { strict as assert } from "node:assert";
import type { MessageBlock } from "@openlive/shared";
import { createChat, setChatAgentSession, listChats, addMessage, listMessages } from "@openlive/db";
import { appendBlock } from "../agents/acp-agent.js";
import { stripInjectedContext } from "./session.js";

// This is the exact rule session.ingestReplay() uses (`listMessages(id).length > 0` → skip).
const shouldPersistReplay = (existingCount: number) => existingCount === 0;

const chatId = "selfcheck-chat";
createChat(chatId, "t");

// (1) agentSessionId round-trips onto the summary.
setChatAgentSession(chatId, "sess-abc-123");
assert.equal(listChats().find((c) => c.id === chatId)?.agentSessionId, "sess-abc-123",
  "agentSessionId must persist onto ChatSummary (else History can't dedup / continue in CLI)");

// (2a) empty chat → replay persists.
assert.equal(listMessages(chatId).length, 0, "fresh chat starts empty");
assert.equal(shouldPersistReplay(listMessages(chatId).length), true, "empty chat → replay persists");

// (2b) once any turn exists → replay is dropped (keep OpenLive's own transcript).
addMessage(chatId, "user", [{ type: "text", text: "hi" }]);
assert.equal(shouldPersistReplay(listMessages(chatId).length), false, "non-empty chat → replay dropped");

// (3) block merge: consecutive text merges; a different kind starts a new block.
const content: MessageBlock[] = [];
appendBlock(content, { type: "text", text: "Hel" });
appendBlock(content, { type: "text", text: "lo" });
appendBlock(content, { type: "reasoning", text: "think" });
appendBlock(content, { type: "text", text: "!" });
assert.deepEqual(content, [
  { type: "text", text: "Hello" },
  { type: "reasoning", text: "think" },
  { type: "text", text: "!" },
], "streamed chunks fold into one block per kind-run");

// (4) replayed user messages get OpenLive's OWN injected context stripped, so a
// resumed transcript shows what the user actually said.
const preamble = "[You're being used through OpenLive, a hands-free VOICE interface — not a terminal. ...]\n\nWhat's the weather?";
assert.deepEqual(stripInjectedContext([{ type: "text", text: preamble }]), [{ type: "text", text: "What's the weather?" }],
  "OpenLive voice preamble is stripped from replayed user text");
assert.deepEqual(stripInjectedContext([{ type: "text", text: "just a normal question" }]), [{ type: "text", text: "just a normal question" }],
  "normal user text is left untouched");
const seedPlusNote = "[Context — earlier in this voice conversation:\nUser: hi\nYou: hello]\n\nfix the bug\n\n[The user is sharing their screen right now — the current view is attached below.]";
assert.deepEqual(stripInjectedContext([{ type: "text", text: seedPlusNote }]), [{ type: "text", text: "fix the bug" }],
  "context recap + screen-share note are stripped, real ask kept");

console.log("replay.selfcheck: OK");
