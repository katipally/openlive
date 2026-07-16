// Self-check: Claude sessions created through OpenLive's ACP path must land in
// Claude Code's OWN history (~/.claude/projects/<cwd-slug>/), with the voice
// preamble in the system prompt — NOT in the saved user message.
//
// Manual-run only (needs Claude auth, spends a few tokens):
//   node services/agent/scripts/persist.selfcheck.mjs
// Drives the pinned adapter directly over stdio with the same session/new
// `_meta.claudeCode.options` OpenLive sends (see CLAUDE_META in ../src/agents/acp-agent.ts).
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { strict as assert } from "node:assert";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const ADAPTER = "@agentclientprotocol/claude-agent-acp@0.59.0"; // keep in sync with ADAPTERS
const PROBE = "Reply with only the word pong";
const CWD = mkdtempSync(join(tmpdir(), "openlive-persist-check-"));
const projectsRoot = join(homedir(), ".claude", "projects");
// Claude's cwd→folder slug rules are its own business (realpath + non-alnum → "-"),
// so locate the transcript by its session-id filename instead of predicting the slug.
const findTranscript = (sessionId) => {
  for (const dir of readdirSync(projectsRoot)) {
    const p = join(projectsRoot, dir, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
};

const child = spawn("npx", ["-y", ADAPTER], { stdio: ["pipe", "pipe", "inherit"] });
let nextId = 1;
const pending = new Map();
const request = (method, params) => {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((res, rej) => {
    pending.set(id, res);
    setTimeout(() => rej(new Error(`timeout: ${method}`)), 180_000).unref();
  });
};
createInterface({ input: child.stdout }).on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && (msg.result !== undefined || msg.error)) {
    const res = pending.get(msg.id);
    if (msg.error) throw new Error(JSON.stringify(msg.error));
    res?.(msg.result);
  } else if (msg.id !== undefined) {
    // Auto-allow permission asks; refuse anything else (fs/terminal aren't advertised).
    const opt = msg.params?.options?.find((o) => o.kind?.startsWith("allow"));
    const reply = msg.method === "session/request_permission" && opt
      ? { result: { outcome: { outcome: "selected", optionId: opt.optionId } } }
      : { error: { code: -32601, message: "not supported" } };
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...reply }) + "\n");
  }
});

await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
const meta = { claudeCode: { options: { persistSession: true, systemPrompt: { type: "preset", preset: "claude_code", append: "[Voice preamble stand-in]" } } } };
const { sessionId } = await request("session/new", { cwd: CWD, mcpServers: [], _meta: meta });
await request("session/prompt", { sessionId, prompt: [{ type: "text", text: PROBE }] });
await new Promise((r) => setTimeout(r, 2000));

// 1. The transcript exists in Claude's native history, named by the ACP session id.
const file = findTranscript(sessionId);
assert.ok(file, `native transcript missing for session ${sessionId} under ${projectsRoot}`);
// 2. The saved user message is exactly what the user said — no injected preamble.
const records = readFileSync(file, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
const userTexts = records
  .filter((r) => r.type === "user")
  .flatMap((r) => (typeof r.message?.content === "string" ? [r.message.content] : (r.message?.content ?? []).map((b) => b.text ?? "")))
  .filter((t) => t.trim());
assert.ok(userTexts.some((t) => t.includes(PROBE)), "probe user message not found in transcript");
assert.ok(userTexts.every((t) => !t.includes("preamble stand-in")), "system-prompt append leaked into a user message");

console.log(`persist.selfcheck ok — ${sessionId} persisted natively, user message clean`);
child.kill();
rmSync(join(file, ".."), { recursive: true, force: true }); // the throwaway slug folder
rmSync(CWD, { recursive: true, force: true });
process.exit(0);
