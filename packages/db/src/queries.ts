import { randomUUID } from "node:crypto";
import type {
  Provider, ChatSummary, ChatMessage,
  ProviderKind, MessageBlock, MessageRole,
} from "@openlive/shared";
import { readJson, updateJson } from "./store";
import { encryptSecret, decryptSecret } from "./crypto";

// Stored shapes (on disk).
interface ProviderRow { id: string; name: string; kind: string; apiKeyCiphertext: string | null; keyLast4: string | null; isDefault: boolean }
interface ChatRow { id: string; title: string; createdAt: string; updatedAt?: string; agentId?: string | null; cwd?: string; agentSessionId?: string }
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

// ─── Chats + messages ──────────────────────────────────────────────────────
export async function createChat(id?: string, title = "Live conversation"): Promise<ChatSummary> {
  const chatId = id ?? randomUUID();
  let out!: ChatRow;
  await updateJson<Conversations>(CONVOS, { chats: [], messages: [] }, (c) => {
    let chat = c.chats.find((x) => x.id === chatId);
    if (!chat) { chat = { id: chatId, title, createdAt: new Date().toISOString() }; c.chats.push(chat); }
    out = chat;
    return c;
  });
  return toSummary(out);
}

const toSummary = (c: ChatRow): ChatSummary => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt ?? c.createdAt, agentId: c.agentId ?? null, cwd: c.cwd ?? "", agentSessionId: c.agentSessionId });

export function listChats(): ChatSummary[] {
  return readConvos().chats
    .map(toSummary)
    .sort((a, b) => ((a.updatedAt ?? a.createdAt) < (b.updatedAt ?? b.createdAt) ? 1 : -1));
}

/** Stamp a session's agent + workspace so history groups it agent→workspace→session.
 *  Called when a conversation binds (built-in or a coding agent) in the lobby/call. */
export async function setChatContext(chatId: string, agentId: string | null, cwd: string): Promise<void> {
  await updateJson<Conversations>(CONVOS, { chats: [], messages: [] }, (c) => {
    const chat = c.chats.find((x) => x.id === chatId);
    if (chat) { chat.agentId = agentId; chat.cwd = cwd; }
    return c;
  });
}

/** Link this chat to the agent's OWN ACP session id (captured on connect). This is
 *  what makes the round-trip work: History dedups the OpenLive chat against the
 *  agent's on-disk session by this id, and it's the id `claude --resume` reopens. */
export async function setChatAgentSession(chatId: string, agentSessionId: string): Promise<void> {
  await updateJson<Conversations>(CONVOS, { chats: [], messages: [] }, (c) => {
    const chat = c.chats.find((x) => x.id === chatId);
    if (chat && chat.agentSessionId !== agentSessionId) chat.agentSessionId = agentSessionId;
    return c;
  });
}

/** Per-chat message counts (for hiding empty sessions — e.g. a lobby connect the
 *  user never actually talked in). */
export function chatMessageCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of readConvos().messages) out[m.chatId] = (out[m.chatId] ?? 0) + 1;
  return out;
}

export async function renameChat(id: string, title: string): Promise<void> {
  await updateJson<Conversations>(CONVOS, { chats: [], messages: [] }, (c) => {
    const chat = c.chats.find((x) => x.id === id);
    if (chat) chat.title = title;
    return c;
  });
}

export async function deleteChat(id: string): Promise<void> {
  await updateJson<Conversations>(CONVOS, { chats: [], messages: [] }, (c) => {
    c.chats = c.chats.filter((x) => x.id !== id);
    c.messages = c.messages.filter((m) => m.chatId !== id);
    return c;
  });
}

// ─── Voice profiles (cloned-voice metadata; wavs live in DATA_DIR/voices) ───
export interface VoiceProfile { id: string; name: string; transcript: string; wavFile: string; createdAt: string; seconds?: number }
const VOICES = "voice-profiles.json";

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
export function getSetting(key: string): string | undefined {
  return readJson<Record<string, string>>(SETTINGS, {})[key];
}

export async function setSetting(key: string, value: string): Promise<void> {
  await updateJson<Record<string, string>>(SETTINGS, {}, (s) => {
    s[key] = value;
    return s;
  });
}

export function getAllSettings(): Record<string, string> {
  return readJson<Record<string, string>>(SETTINGS, {});
}

// ─── Messages ────────────────────────────────────────────────────────────────
// Array insertion order == chronological order (append-only), so listMessages
// preserves user→assistant ordering without a separate tiebreaker.
export async function addMessage(chatId: string, role: MessageRole, content: MessageBlock[], live = false): Promise<ChatMessage> {
  const now = new Date().toISOString();
  const row: MessageRow = { id: randomUUID(), chatId, role, content, live, createdAt: now };
  await updateJson<Conversations>(CONVOS, { chats: [], messages: [] }, (c) => {
    c.messages.push(row);
    const chat = c.chats.find((x) => x.id === chatId);
    if (chat) chat.updatedAt = now; // last-activity, for history ordering
    return c;
  });
  return { ...row };
}

export function listMessages(chatId: string): ChatMessage[] {
  return readConvos().messages
    .filter((m) => m.chatId === chatId)
    .map((m) => ({ id: m.id, chatId: m.chatId, role: m.role, content: m.content, live: !!m.live, createdAt: m.createdAt }));
}
