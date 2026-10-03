import { randomUUID } from "node:crypto";
import type {
  Provider, ChatSummary, ChatMessage,
  ProviderKind, MessageBlock, MessageRole,
} from "@openlive/shared";
import { join } from "node:path";
import { SECRET_SETTINGS } from "@openlive/shared/home";
import { readJson, updateJson } from "./store";
import { encryptSecret, decryptSecret } from "./crypto";
import { getDb, withBusyRetry } from "./sqlite";
import { PATHS } from "./paths";

// Stored shapes. Providers/settings/voice-profiles live in tiny JSON files;
// chats + messages live in SQLite (append-shaped, growing — see sqlite.ts).
interface ProviderRow { id: string; name: string; kind: string; apiKeyCiphertext: string | null; keyLast4: string | null; isDefault: boolean }
interface ChatDbRow { id: string; title: string; created_at: string; updated_at: string | null; agent_id: string | null; cwd: string | null; agent_session_id: string | null }

const PROVIDERS = PATHS.providers;
const SETTINGS = PATHS.settings;

const readProviders = () => readJson<ProviderRow[]>(PROVIDERS, []);

// ─── Providers ─────────────────────────────────────────────────────────────
function toProvider(r: ProviderRow): Provider {
  return { id: r.id, name: r.name, kind: r.kind, keyLast4: r.keyLast4, hasKey: !!r.apiKeyCiphertext, isDefault: !!r.isDefault };
}

export function listProviders(): Provider[] {
  return readProviders()
    .map(toProvider)
    .sort((a, b) => (Number(b.isDefault) - Number(a.isDefault)) || a.name.localeCompare(b.name));
}

export async function createProvider(p: {
  name: string; kind: ProviderKind; apiKey?: string | null; isDefault?: boolean;
}): Promise<Provider> {
  const key = p.apiKey?.trim() || null; // trim: pasted keys often carry a stray space/newline → 401
  const row: ProviderRow = {
    id: randomUUID(), name: p.name, kind: p.kind,
    apiKeyCiphertext: key ? encryptSecret(key) : null, keyLast4: key ? key.slice(-4) : null,
    isDefault: !!p.isDefault,
  };
  await updateJson<ProviderRow[]>(PROVIDERS, [], (rows) => {
    if (p.isDefault) rows.forEach((r) => (r.isDefault = false));
    rows.push(row);
    return rows;
  });
  return toProvider(row);
}

/** Upsert a provider's key by registry kind, ATOMICALLY. The find-or-create runs
 *  inside the single write transaction, so two concurrent first-time POSTs for the
 *  same kind can't each create a row (the second sees the first's row). */
export async function upsertProviderByKind(kind: ProviderKind, name: string, apiKey?: string | null): Promise<Provider> {
  const key = apiKey?.trim() || null;
  let out!: Provider;
  await updateJson<ProviderRow[]>(PROVIDERS, [], (rows) => {
    let row = rows.find((r) => r.kind === kind);
    if (!row) {
      row = { id: randomUUID(), name, kind, apiKeyCiphertext: null, keyLast4: null, isDefault: rows.length === 0 };
      rows.push(row);
    }
    if (key) { row.apiKeyCiphertext = encryptSecret(key); row.keyLast4 = key.slice(-4); }
    out = toProvider(row);
    return rows;
  });
  return out;
}

export async function updateProvider(id: string, p: {
  name?: string; apiKey?: string | null; isDefault?: boolean;
}): Promise<Provider | undefined> {
  let out: Provider | undefined;
  await updateJson<ProviderRow[]>(PROVIDERS, [], (rows) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return rows;
    if (p.name !== undefined) row.name = p.name;
    const key = p.apiKey?.trim();
    if (key) { row.apiKeyCiphertext = encryptSecret(key); row.keyLast4 = key.slice(-4); }
    if (p.isDefault) { rows.forEach((r) => (r.isDefault = false)); row.isDefault = true; }
    out = toProvider(row);
    return rows;
  });
  return out;
}

/** Remove a provider's stored key (so a wrong/stale one can be cleared). */
export async function clearProviderKey(id: string): Promise<Provider | undefined> {
  let out: Provider | undefined;
  await updateJson<ProviderRow[]>(PROVIDERS, [], (rows) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return rows;
    row.apiKeyCiphertext = null; row.keyLast4 = null;
    out = toProvider(row);
    return rows;
  });
  return out;
}

/** Server-only: decrypt a provider's API key. Never exposed over HTTP. Tolerant
 *  of a decrypt failure (e.g. the enc-key changed) — returns null. */
export function getProviderApiKey(id: string): string | null {
  const row = readProviders().find((r) => r.id === id);
  if (!row?.apiKeyCiphertext) return null;
  try { return decryptSecret(row.apiKeyCiphertext); } catch { return null; }
}

// ─── Chats + messages (SQLite) ─────────────────────────────────────────────
const toSummary = (c: ChatDbRow): ChatSummary => ({
  id: c.id, title: c.title, createdAt: c.created_at, updatedAt: c.updated_at ?? c.created_at,
  agentId: c.agent_id ?? null, cwd: c.cwd ?? "", agentSessionId: c.agent_session_id ?? undefined,
});

export async function createChat(id?: string, title = "Live conversation"): Promise<ChatSummary> {
  const chatId = id ?? randomUUID();
  const db = getDb();
  withBusyRetry(() => db.prepare(
    "INSERT OR IGNORE INTO chats (id, title, created_at) VALUES (?, ?, ?)",
  ).run(chatId, title, new Date().toISOString()));
  const row = db.prepare("SELECT * FROM chats WHERE id = ?").get(chatId) as unknown as ChatDbRow;
  return toSummary(row);
}

export function listChats(): ChatSummary[] {
  const rows = getDb().prepare(
    "SELECT * FROM chats ORDER BY COALESCE(updated_at, created_at) DESC",
  ).all() as unknown as ChatDbRow[];
  return rows.map(toSummary);
}

/** Whether a chat is saved. O(log chats): the id is the primary key. */
export function chatExists(id: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM chats WHERE id = ?").get(id);
}

/** Stamp a session's agent + workspace so history groups it agent→workspace→session.
 *  Called when a conversation binds (built-in or a coding agent) in the lobby/call. */
export async function setChatContext(chatId: string, agentId: string | null, cwd: string): Promise<void> {
  withBusyRetry(() => getDb().prepare(
    "UPDATE chats SET agent_id = ?, cwd = ? WHERE id = ?",
  ).run(agentId, cwd, chatId));
}

/** Link this chat to the agent's OWN ACP session id (captured on connect). This is
 *  what makes the round-trip work: History dedups the OpenLive chat against the
 *  agent's on-disk session by this id, and it's the id `claude --resume` reopens. */
export async function setChatAgentSession(chatId: string, agentSessionId: string): Promise<void> {
  withBusyRetry(() => getDb().prepare(
    "UPDATE chats SET agent_session_id = ? WHERE id = ? AND (agent_session_id IS NOT ? )",
  ).run(agentSessionId, chatId, agentSessionId));
}

/** Per-chat message counts (for hiding empty sessions — e.g. a lobby connect the
 *  user never actually talked in). */
export function chatMessageCounts(): Record<string, number> {
  const rows = getDb().prepare(
    "SELECT chat_id, COUNT(*) AS n FROM messages GROUP BY chat_id",
  ).all() as unknown as { chat_id: string; n: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.chat_id] = Number(r.n);
  return out;
}

export async function renameChat(id: string, title: string): Promise<void> {
  withBusyRetry(() => getDb().prepare("UPDATE chats SET title = ? WHERE id = ?").run(title, id));
}

export async function deleteChat(id: string): Promise<void> {
  withBusyRetry(() => getDb().prepare("DELETE FROM chats WHERE id = ?").run(id)); // messages cascade
  // Its settings too (bind:, agentCwd:, agentCut:, acpSession:), each keyed `<name>:<chat id>`. O(settings).
  await updateJson<Record<string, string>>(SETTINGS, {}, (s) => Object.fromEntries(Object.entries(s).filter(([k]) => !k.endsWith(`:${id}`))));
}

/** Deletes OpenLive's own chats last active before `before` (an ISO time), all
 *  but `except` (the one open now), with their settings. Agents' own CLI
 *  sessions never live here, so they are never touched. Returns how many went.
 *  O(chats + settings): one delete, one settings pass with a set lookup per key. */
export async function deleteChatsBefore(before: string, except = ""): Promise<number> {
  const rows = withBusyRetry(() => getDb().prepare(
    "DELETE FROM chats WHERE COALESCE(updated_at, created_at) < ? AND id != ? RETURNING id", // messages cascade
  ).all(before, except)) as unknown as { id: string }[];
  if (!rows.length) return 0;
  const gone = new Set(rows.map((r) => r.id));
  await updateJson<Record<string, string>>(SETTINGS, {}, (s) => Object.fromEntries(Object.entries(s).filter(([k]) => !gone.has(k.slice(k.indexOf(":") + 1)))));
  return rows.length;
}

// ─── Voice profiles (cloned-voice metadata; wavs live in DATA_DIR/voices) ───
export interface VoiceProfile { id: string; name: string; transcript: string; wavFile: string; createdAt: string; seconds?: number }
const VOICES = join(PATHS.data, "voice-profiles.json");

export function listVoiceProfiles(): VoiceProfile[] {
  return readJson<VoiceProfile[]>(VOICES, []);
}

export async function createVoiceProfile(p: { name: string; transcript: string; wavFile: string; seconds?: number }): Promise<VoiceProfile> {
  const row: VoiceProfile = { id: randomUUID(), createdAt: new Date().toISOString(), ...p };
  await updateJson<VoiceProfile[]>(VOICES, [], (rows) => { rows.push(row); return rows; });
  return row;
}

export async function renameVoiceProfile(id: string, name: string): Promise<VoiceProfile | undefined> {
  let out: VoiceProfile | undefined;
  await updateJson<VoiceProfile[]>(VOICES, [], (rows) => {
    const row = rows.find((r) => r.id === id);
    if (row) { row.name = name; out = row; }
    return rows;
  });
  return out;
}

export async function deleteVoiceProfile(id: string): Promise<VoiceProfile | undefined> {
  let removed: VoiceProfile | undefined;
  await updateJson<VoiceProfile[]>(VOICES, [], (rows) => {
    removed = rows.find((r) => r.id === id);
    return rows.filter((r) => r.id !== id);
  });
  return removed;
}

// ─── Settings (key/value) ──────────────────────────────────────────────────
// settings.json is plain and edited by hand, so a secret setting (SECRET_SETTINGS)
// is kept encrypted in secrets/settings.json instead, behind the same calls.
const secret = (key: string) => SECRET_SETTINGS.includes(key);

function open(sealed: string | undefined): string | undefined {
  if (sealed === undefined) return undefined;
  try { return decryptSecret(sealed); } catch { return undefined; } // the enc-key changed; it is set again
}

export function getSetting(key: string): string | undefined {
  if (secret(key)) return open(readJson<Record<string, string>>(PATHS.settingSecrets, {})[key]);
  return readJson<Record<string, string>>(SETTINGS, {})[key];
}

export const setSetting = (key: string, value: string): Promise<void> => updateSetting(key, () => value);

/** One setting's read-modify-write, under the store's lock, so two processes changing it never lose each other's write. */
export async function updateSetting(key: string, fn: (cur: string | undefined) => string): Promise<void> {
  if (secret(key)) {
    await updateJson<Record<string, string>>(PATHS.settingSecrets, {}, (s) => {
      const next = fn(open(s[key]));
      if (next) s[key] = encryptSecret(next); else delete s[key];
      return s;
    });
    return;
  }
  await updateJson<Record<string, string>>(SETTINGS, {}, (s) => {
    s[key] = fn(s[key]);
    return s;
  });
}

/** The plain settings. Secret ones are only ever read by name. */
export function getAllSettings(): Record<string, string> {
  return readJson<Record<string, string>>(SETTINGS, {});
}

// ─── Memory (memory.json: the notes `remember` keeps, oldest first) ───────────
export const getMemory = (): unknown => readJson<unknown>(PATHS.memory, []);

/** Read, change and write the notes under the store's lock, as updateSetting does for a setting. */
export async function updateMemory(fn: (cur: unknown) => unknown): Promise<void> {
  await updateJson<unknown>(PATHS.memory, [], fn);
}

// ─── Messages ────────────────────────────────────────────────────────────────
// AUTOINCREMENT seq == chronological order (append-only), so listMessages
// preserves user→assistant ordering without a separate tiebreaker.
export async function addMessage(chatId: string, role: MessageRole, content: MessageBlock[], live = false): Promise<ChatMessage> {
  const now = new Date().toISOString();
  const id = randomUUID();
  const db = getDb();
  withBusyRetry(() => {
    db.prepare(
      "INSERT INTO messages (id, chat_id, role, content, live, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, chatId, role, JSON.stringify(content), live ? 1 : 0, now);
    db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(now, chatId); // last-activity, for history ordering
  });
  return { id, chatId, role, content, live, createdAt: now };
}

/** Rewrites a saved message's blocks: a live reply cut back to what was voiced. */
export function updateMessageContent(id: string, content: MessageBlock[]): void {
  const db = getDb();
  withBusyRetry(() => { db.prepare("UPDATE messages SET content = ? WHERE id = ?").run(JSON.stringify(content), id); });
}

export function listMessages(chatId: string): ChatMessage[] {
  const rows = getDb().prepare(
    "SELECT id, chat_id, role, content, live, created_at FROM messages WHERE chat_id = ? ORDER BY seq",
  ).all(chatId) as unknown as { id: string; chat_id: string; role: MessageRole; content: string; live: number; created_at: string }[];
  return rows.map((m) => ({
    id: m.id, chatId: m.chat_id, role: m.role,
    content: JSON.parse(m.content) as MessageBlock[], live: !!m.live, createdAt: m.created_at,
  }));
}
