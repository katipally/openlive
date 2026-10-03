import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
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
    process.env.OPENLIVE_HOME = dir;
    // paths.ts reads the env at module load — force re-evaluation.
    vi.resetModules();
  });
  afterEach(async () => {
    const { closeDbForTests } = await import("./sqlite");
    closeDbForTests();
    delete process.env.OPENLIVE_HOME;
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
    // Moved into data/ with the rest of the old flat layout, then imported there.
    expect(existsSync(join(dir, "conversations.json"))).toBe(false);
    expect(existsSync(join(dir, "data", "conversations.json"))).toBe(false);
    expect(existsSync(join(dir, "data", "conversations.json.migrated.bak"))).toBe(true);
  });

  it("is idempotent — reopening after migration does not duplicate or re-import", async () => {
    writeFileSync(join(dir, "conversations.json"), JSON.stringify(FIXTURE));
    let q = await freshDb();
    expect(q.listChats()).toHaveLength(2);

    // Simulate a second process/boot: drop the singleton, put a NEW json in place
    // (must be ignored — the meta flag says we already migrated).
    writeFileSync(join(dir, "data", "conversations.json"), JSON.stringify({ chats: [{ id: "evil", title: "X", createdAt: "2026-02-01T00:00:00.000Z" }], messages: [] }));
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

    for (const k of ["bind", "agentCwd", "agentCut", "acpSession"]) await q.setSetting(`${k}:${chat.id}`, "x");
    await q.setSetting("bind:other-chat", "codex");
    await q.deleteChat(chat.id);
    expect(q.listChats()).toHaveLength(0);
    expect(q.listMessages(chat.id)).toHaveLength(0); // cascade
    expect(q.getAllSettings()).toEqual({ "bind:other-chat": "codex" }); // its per-chat settings go with it
  });

  it("deletes chats last active before a time, all but the open one, with their settings", async () => {
    const q = await freshDb();
    const old = await q.createChat("old");
    const open = await q.createChat("open");
    await q.addMessage(old.id, "user", [{ type: "text", text: "a" }]);
    await q.setSetting(`bind:${old.id}`, "codex");
    await q.setSetting("agentHidden:codex", "1");
    const cut = new Date(Date.now() + 1000).toISOString();
    expect(await q.deleteChatsBefore(cut, open.id)).toBe(1);
    expect(q.listChats().map((c) => c.id)).toEqual([open.id]);
    expect(q.listMessages(old.id)).toHaveLength(0);
    expect(q.getAllSettings()).toEqual({ "agentHidden:codex": "1" });
    expect(await q.deleteChatsBefore("2000-01-01T00:00:00.000Z")).toBe(0);
  });

  it("a deleted chat's words are gone from the database files, not only from the list", async () => {
    const q = await freshDb();
    const { DB_FILE } = await import("./sqlite");
    const onDisk = () => [DB_FILE(), `${DB_FILE()}-wal`].map((f) => (existsSync(f) ? readFileSync(f).toString("latin1") : "")).join("");
    const one = await q.createChat("one");
    const two = await q.createChat("two");
    const keep = await q.createChat("keep");
    await q.addMessage(one.id, "user", [{ type: "text", text: "zebra-marker-one" }]);
    await q.addMessage(two.id, "user", [{ type: "text", text: "zebra-marker-two" }]);
    await q.addMessage(keep.id, "user", [{ type: "text", text: "zebra-marker-kept" }]);
    expect(onDisk()).toContain("zebra-marker-one");
    await q.deleteChat(one.id);
    expect(onDisk()).not.toContain("zebra-marker-one");
    await q.deleteChatsBefore(new Date(Date.now() + 1000).toISOString(), keep.id);
    expect(onDisk()).not.toContain("zebra-marker-two");
    expect(onDisk()).toContain("zebra-marker-kept");
  });

  it("keeps a secret setting encrypted outside settings.json, behind the same calls", async () => {
    const q = await freshDb();
    await q.setSetting("customInstructions", "be brief");
    await q.setSetting("exa_api_key", "exa_plain_123");
    expect(q.getSetting("exa_api_key")).toBe("exa_plain_123");
    expect(q.getAllSettings()).toEqual({ customInstructions: "be brief" });
    expect(readFileSync(join(dir, "settings.json"), "utf8")).not.toContain("exa_plain_123");
    expect(readFileSync(join(dir, "secrets", "settings.json"), "utf8")).not.toContain("exa_plain_123");
    await q.setSetting("exa_api_key", "");
    expect(q.getSetting("exa_api_key")).toBeUndefined();
  });

  it("keeps memory in memory.json, under the store's lock", async () => {
    const q = await freshDb();
    await Promise.all(["a", "b", "c"].map((t) => q.updateMemory((cur) => [...(cur as string[]), t])));
    expect((q.getMemory() as string[]).sort()).toEqual(["a", "b", "c"]);
    expect(JSON.parse(readFileSync(join(dir, "memory.json"), "utf8")).sort()).toEqual(["a", "b", "c"]);
  });

  it("createChat is idempotent for an existing id", async () => {
    const q = await freshDb();
    const a = await q.createChat("same-id", "A");
    const b = await q.createChat("same-id", "B (ignored)");
    expect(b.title).toBe(a.title);
    expect(q.listChats()).toHaveLength(1);
  });
});
