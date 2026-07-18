import { existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import lockfile from "proper-lockfile";
import { DATA_DIR } from "./paths";
import { readJson } from "./store";

// One-time import of the legacy conversations.json into SQLite. Both processes
// (web + agent) may hit first-open simultaneously on the first boot after an
// upgrade, so the import is guarded by the same cross-process lockfile the JSON
// store used, re-checked inside the lock, and applied in one transaction. The
// source file is renamed to .migrated.bak afterwards — the recovery hatch if
// anything ever looks wrong.

interface ChatRow { id: string; title: string; createdAt: string; updatedAt?: string; agentId?: string | null; cwd?: string; agentSessionId?: string }
interface MessageRow { id: string; chatId: string; role: string; content: unknown; live: boolean; createdAt: string }
interface Conversations { chats: ChatRow[]; messages: MessageRow[] }

const CONVOS = "conversations.json";
const FLAG = "migrated_json";

const migrated = (db: DatabaseSync) =>
  !!db.prepare("SELECT value FROM meta WHERE key = ?").get(FLAG);

export function migrateConversationsJson(db: DatabaseSync): void {
  const src = resolve(DATA_DIR, CONVOS);
  if (migrated(db) || !existsSync(src)) return;

  // proper-lockfile is callback/promise-based; hold the lock synchronously via
  // lockSync — this runs once per install, at boot, before any queries.
  const release = lockfile.lockSync(src, { realpath: false, stale: 15000 });
  try {
    if (migrated(db)) return; // the other process imported while we waited

    const data = readJson<Conversations>(CONVOS, { chats: [], messages: [] });
    const insChat = db.prepare(
      "INSERT OR IGNORE INTO chats (id, title, created_at, updated_at, agent_id, cwd, agent_session_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const insMsg = db.prepare(
      "INSERT OR IGNORE INTO messages (id, chat_id, role, content, live, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    db.exec("BEGIN");
    try {
      for (const c of data.chats) {
        insChat.run(c.id, c.title, c.createdAt, c.updatedAt ?? null, c.agentId ?? null, c.cwd ?? null, c.agentSessionId ?? null);
      }
      // Array order == chronological order in the JSON store; AUTOINCREMENT seq
      // preserves it. Skip messages whose chat row is missing (FK would reject).
      const chatIds = new Set(data.chats.map((c) => c.id));
      for (const m of data.messages) {
        if (!chatIds.has(m.chatId)) continue;
        insMsg.run(m.id, m.chatId, m.role, JSON.stringify(m.content ?? []), m.live ? 1 : 0, m.createdAt);
      }
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(FLAG, new Date().toISOString());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    renameSync(src, `${src}.migrated.bak`);
  } finally {
    release();
  }
}
