import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "./paths";
import { migrateConversationsJson } from "./migrate-conversations";

// Chats + messages live in SQLite (node:sqlite — built into Node ≥22.13, no
// native dependency, so desktop universal builds and the container stay
// pure-JS). The other stores (providers/settings/voice-profiles) remain tiny
// JSON files — they're small, rarely written, and not append-shaped.
//
// TWO processes open this database (the Next web server and the agent service).
// WAL + busy_timeout serializes their writes; each process holds one lazy
// singleton connection.

export const DB_FILE = () => resolve(DATA_DIR, "openlive.db");

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE());
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chats (
      id               TEXT PRIMARY KEY,
      title            TEXT NOT NULL,
      created_at       TEXT NOT NULL,
      updated_at       TEXT,
      agent_id         TEXT,
      cwd              TEXT,
      agent_session_id TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT, -- append order == chronological order
      id         TEXT NOT NULL UNIQUE,
      chat_id    TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,  -- JSON-serialized MessageBlock[]
      live       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, seq);
  `);
  migrateConversationsJson(db);
  return db;
}

/** Retry a write once past a stray SQLITE_BUSY — belt-and-braces on top of
 *  busy_timeout (which already waits 5s inside SQLite before erroring). */
export function withBusyRetry<T>(fn: () => T): T {
  try { return fn(); }
  catch (e) {
    if (e instanceof Error && /SQLITE_BUSY/.test(e.message)) return fn();
    throw e;
  }
}

/** Test hook: close and forget the singleton so a fresh open re-runs setup. */
export function closeDbForTests(): void {
  try { db?.close(); } catch { /* */ }
  db = null;
}
