import { randomUUID } from "node:crypto";
import type {
  Provider, ChatSummary, ChatMessage,
  ProviderKind, MessageBlock, MessageRole,
} from "@openlive/shared";
import { readJson, writeJson } from "./store";
import { encryptSecret, decryptSecret } from "./crypto";

// Stored shapes (on disk).
interface ProviderRow { id: string; name: string; kind: string; apiKeyCiphertext: string | null; keyLast4: string | null; isDefault: boolean }
interface ChatRow { id: string; title: string; createdAt: string; updatedAt?: string; agentId?: string | null; cwd?: string }
interface MessageRow { id: string; chatId: string; role: MessageRole; content: MessageBlock[]; live: boolean; createdAt: string }
interface Conversations { chats: ChatRow[]; messages: MessageRow[] }

const PROVIDERS = "providers.json";
const SETTINGS = "settings.json";
const CONVOS = "conversations.json";

const readProviders = () => readJson<ProviderRow[]>(PROVIDERS, []);
const readConvos = () => readJson<Conversations>(CONVOS, { chats: [], messages: [] });

// ─── Providers ─────────────────────────────────────────────────────────────
function toProvider(r: ProviderRow): Provider {
  return { id: r.id, name: r.name, kind: r.kind, keyLast4: r.keyLast4, hasKey: !!r.apiKeyCiphertext, isDefault: !!r.isDefault };
}

export function listProviders(): Provider[] {
  return readProviders()
    .map(toProvider)
    .sort((a, b) => (Number(b.isDefault) - Number(a.isDefault)) || a.name.localeCompare(b.name));
}

export function createProvider(p: {
  name: string; kind: ProviderKind; apiKey?: string | null; isDefault?: boolean;
}): Provider {
  const rows = readProviders();
  const key = p.apiKey?.trim() || null; // trim: pasted keys often carry a stray space/newline → 401
  if (p.isDefault) rows.forEach((r) => (r.isDefault = false));
  const row: ProviderRow = {
    id: randomUUID(), name: p.name, kind: p.kind,
    apiKeyCiphertext: key ? encryptSecret(key) : null, keyLast4: key ? key.slice(-4) : null,
    isDefault: !!p.isDefault,
  };
  rows.push(row);
  writeJson(PROVIDERS, rows);
  return toProvider(row);
}

export function updateProvider(id: string, p: {
  name?: string; apiKey?: string | null; isDefault?: boolean;
}): Provider | undefined {
  const rows = readProviders();
  const row = rows.find((r) => r.id === id);
  if (!row) return undefined;
  if (p.name !== undefined) row.name = p.name;
  const key = p.apiKey?.trim();
  if (key) { row.apiKeyCiphertext = encryptSecret(key); row.keyLast4 = key.slice(-4); }
  if (p.isDefault) { rows.forEach((r) => (r.isDefault = false)); row.isDefault = true; }
  writeJson(PROVIDERS, rows);
  return toProvider(row);
}

/** Remove a provider's stored key (so a wrong/stale one can be cleared). */
export function clearProviderKey(id: string): Provider | undefined {
  const rows = readProviders();
  const row = rows.find((r) => r.id === id);
  if (!row) return undefined;
  row.apiKeyCiphertext = null; row.keyLast4 = null;
  writeJson(PROVIDERS, rows);
  return toProvider(row);
}

/** Server-only: decrypt a provider's API key. Never exposed over HTTP. Tolerant
 *  of a decrypt failure (e.g. the enc-key changed) — returns null. */
export function getProviderApiKey(id: string): string | null {
  const row = readProviders().find((r) => r.id === id);
  if (!row?.apiKeyCiphertext) return null;
  try { return decryptSecret(row.apiKeyCiphertext); } catch { return null; }
}

// ─── Chats + messages ──────────────────────────────────────────────────────
export function createChat(id?: string, title = "Live conversation"): ChatSummary {
  const chatId = id ?? randomUUID();
  const c = readConvos();
  let chat = c.chats.find((x) => x.id === chatId);
  if (!chat) { chat = { id: chatId, title, createdAt: new Date().toISOString() }; c.chats.push(chat); writeJson(CONVOS, c); }
  return toSummary(chat);
}

const toSummary = (c: ChatRow): ChatSummary => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt ?? c.createdAt, agentId: c.agentId ?? null, cwd: c.cwd ?? "" });

export function listChats(): ChatSummary[] {
  return readConvos().chats
    .map(toSummary)
    .sort((a, b) => ((a.updatedAt ?? a.createdAt) < (b.updatedAt ?? b.createdAt) ? 1 : -1));
}

/** Stamp a session's agent + workspace so history groups it agent→workspace→session.
 *  Called when a conversation binds (built-in or a coding agent) in the lobby/call. */
export function setChatContext(chatId: string, agentId: string | null, cwd: string): void {
  const c = readConvos();
  const chat = c.chats.find((x) => x.id === chatId);
  if (!chat) return;
  chat.agentId = agentId; chat.cwd = cwd;
  writeJson(CONVOS, c);
}

/** Per-chat message counts (for hiding empty sessions — e.g. a lobby connect the
 *  user never actually talked in). */
export function chatMessageCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of readConvos().messages) out[m.chatId] = (out[m.chatId] ?? 0) + 1;
  return out;
}

export function renameChat(id: string, title: string): void {
  const c = readConvos();
  const chat = c.chats.find((x) => x.id === id);
  if (chat) { chat.title = title; writeJson(CONVOS, c); }
}

export function deleteChat(id: string): void {
  const c = readConvos();
  c.chats = c.chats.filter((x) => x.id !== id);
  c.messages = c.messages.filter((m) => m.chatId !== id);
  writeJson(CONVOS, c);
}

// ─── Settings (key/value) ──────────────────────────────────────────────────
export function getSetting(key: string): string | undefined {
  return readJson<Record<string, string>>(SETTINGS, {})[key];
}

export function setSetting(key: string, value: string): void {
  const s = readJson<Record<string, string>>(SETTINGS, {});
  s[key] = value;
  writeJson(SETTINGS, s);
}

export function getAllSettings(): Record<string, string> {
  return readJson<Record<string, string>>(SETTINGS, {});
}

// ─── Messages ────────────────────────────────────────────────────────────────
// Array insertion order == chronological order (append-only), so listMessages
// preserves user→assistant ordering without a separate tiebreaker.
export function addMessage(chatId: string, role: MessageRole, content: MessageBlock[], live = false): ChatMessage {
  const c = readConvos();
  const now = new Date().toISOString();
  const row: MessageRow = { id: randomUUID(), chatId, role, content, live, createdAt: now };
  c.messages.push(row);
  const chat = c.chats.find((x) => x.id === chatId);
  if (chat) chat.updatedAt = now; // last-activity, for history ordering
  writeJson(CONVOS, c);
  return { ...row };
}

export function listMessages(chatId: string): ChatMessage[] {
  return readConvos().messages
    .filter((m) => m.chatId === chatId)
    .map((m) => ({ id: m.id, chatId: m.chatId, role: m.role, content: m.content, live: !!m.live, createdAt: m.createdAt }));
}
