import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The db package resolves DATA_DIR at import time, so point it at a temp dir
// BEFORE importing. vi.resetModules between tests re-evaluates the modules.
let dir: string;

const FIXTURE = {
  chats: [
    { id: "c1", title: "First", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", agentId: "claude-code", cwd: "/tmp/p", agentSessionId: "s-1" },
    { id: "c2", title: "Second", createdAt: "2026-01-03T00:00:00.000Z" },
  ],
  messages: [
    { id: "m1", chatId: "c1", role: "user", content: [{ type: "text", text: "hi" }], live: true, createdAt: "2026-01-01T00:00:01.000Z" },
    { id: "m2", chatId: "c1", role: "assistant", content: [{ type: "text", text: "hello" }], live: true, createdAt: "2026-01-01T00:00:02.000Z" },
    // Same-timestamp pair: array order must survive (seq, not createdAt, orders).
    { id: "m3", chatId: "c1", role: "user", content: [{ type: "text", text: "again" }], live: false, createdAt: "2026-01-01T00:00:02.000Z" },
    { id: "m4", chatId: "c2", role: "user", content: [], live: false, createdAt: "2026-01-03T00:00:01.000Z" },
    // Orphan (no chat row) — must be skipped, not crash the import.
    { id: "m5", chatId: "ghost", role: "user", content: [], live: false, createdAt: "2026-01-04T00:00:00.000Z" },
  ],
};

async function freshDb() {
  const { closeDbForTests } = await import("./sqlite");
  closeDbForTests();
  return import("./queries");
}

describe("sqlite chat store + JSON migration", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oldb-"));
    process.env.OPENLIVE_DATA_DIR = dir;
    // paths.ts reads the env at module load — force re-evaluation.
    vi.resetModules();
  });
  afterEach(async () => {
    const { closeDbForTests } = await import("./sqlite");
    closeDbForTests();
    delete process.env.OPENLIVE_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("imports conversations.json faithfully (order, fields, orphans) and renames it", async () => {
    writeFileSync(join(dir, "conversations.json"), JSON.stringify(FIXTURE));
    const q = await freshDb();

    const chats = q.listChats();
    expect(chats.map((c) => c.id)).toEqual(["c2", "c1"]); // updatedAt DESC: c2(01-03) > c1(01-02)
    const c1 = chats.find((c) => c.id === "c1")!;
    expect(c1).toMatchObject({ title: "First", agentId: "claude-code", cwd: "/tmp/p", agentSessionId: "s-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" });

    const msgs = q.listMessages("c1");
    expect(msgs.map((m) => m.id)).toEqual(["m1", "m2", "m3"]); // array order preserved incl. equal timestamps
    expect(msgs[0]!.content).toEqual([{ type: "text", text: "hi" }]);
    expect(msgs[0]!.live).toBe(true);
    expect(msgs[2]!.live).toBe(false);

    expect(q.chatMessageCounts()).toEqual({ c1: 3, c2: 1 });
    expect(existsSync(join(dir, "conversations.json"))).toBe(false);
    expect(existsSync(join(dir, "conversations.json.migrated.bak"))).toBe(true);
  });

  it("is idempotent — reopening after migration does not duplicate or re-import", async () => {
    writeFileSync(join(dir, "conversations.json"), JSON.stringify(FIXTURE));
    let q = await freshDb();
    expect(q.listChats()).toHaveLength(2);

    // Simulate a second process/boot: drop the singleton, put a NEW json in place
    // (must be ignored — the meta flag says we already migrated).
    writeFileSync(join(dir, "conversations.json"), JSON.stringify({ chats: [{ id: "evil", title: "X", createdAt: "2026-02-01T00:00:00.000Z" }], messages: [] }));
    q = await freshDb();
    expect(q.listChats().map((c) => c.id).sort()).toEqual(["c1", "c2"]);
  });

  it("supports the full CRUD surface on a fresh (no-JSON) install", async () => {
    const q = await freshDb();
    const chat = await q.createChat(undefined, "Fresh");
    await q.setChatContext(chat.id, "codex", "/tmp/w");
    await q.setChatAgentSession(chat.id, "sess-9");
    await q.addMessage(chat.id, "user", [{ type: "text", text: "one" }], true);
    await q.addMessage(chat.id, "assistant", [{ type: "text", text: "two" }]);

    const listed = q.listChats();
    expect(listed).toHaveLength(1);
    expect(listed[0]!).toMatchObject({ agentId: "codex", cwd: "/tmp/w", agentSessionId: "sess-9" });
    expect(q.listMessages(chat.id).map((m) => (m.content[0] as { text: string }).text)).toEqual(["one", "two"]);

    await q.renameChat(chat.id, "Renamed");
    expect(q.listChats()[0]!.title).toBe("Renamed");

    await q.deleteChat(chat.id);
    expect(q.listChats()).toHaveLength(0);
    expect(q.listMessages(chat.id)).toHaveLength(0); // cascade
  });

  it("createChat is idempotent for an existing id", async () => {
    const q = await freshDb();
    const a = await q.createChat("same-id", "A");
    const b = await q.createChat("same-id", "B (ignored)");
    expect(b.title).toBe(a.title);
    expect(q.listChats()).toHaveLength(1);
  });
});
