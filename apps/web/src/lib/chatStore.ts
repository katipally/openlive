"use client";

import { create } from "zustand";
import type { SseEvent } from "@openlive/shared";

// Minimal transcript store for the live call. useLiveSession drives it
// imperatively (liveUserTurn / liveText / liveReason / liveEvent / liveFinish);
// the TranscriptPanel reads it via useChat(). Assistant content is kept as an
// ORDERED list of parts (reasoning · tool · spoken text) so the panel renders the
// turn the way it happened — thinking and tool use interleaved, then the answer —
// instead of piling tools on top. Spoken text is set word-by-word, paced to the
// VOICE (not the generated stream), so it always equals what was actually said.

export type Part =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; id?: string; tool: string; summary?: string; detail?: string; done: boolean };

export interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  text: string;   // user turns only
  parts: Part[];  // assistant turns only
  done: boolean;
}

interface ChatState {
  byChat: Record<string, ChatMsg[]>;
  _set: (chatId: string, fn: (msgs: ChatMsg[]) => ChatMsg[]) => void;
}

let seq = 0;
const nextId = () => `m${++seq}`;

const useChatState = create<ChatState>((set) => ({
  byChat: {},
  _set: (chatId, fn) =>
    set((s) => ({ byChat: { ...s.byChat, [chatId]: fn(s.byChat[chatId] ?? []) } })),
}));

function patch(chatId: string, id: string, fn: (m: ChatMsg) => ChatMsg) {
  useChatState.getState()._set(chatId, (msgs) => msgs.map((m) => (m.id === id ? fn(m) : m)));
}

export const chatStore = {
  // Commit a completed user turn and open a fresh assistant turn; returns its id.
  liveUserTurn(chatId: string, text: string): string {
    const userId = nextId();
    const asstId = nextId();
    useChatState.getState()._set(chatId, (msgs) => [
      ...msgs,
      { id: userId, role: "user", text, parts: [], done: true },
      { id: asstId, role: "assistant", text: "", parts: [], done: false },
    ]);
    return asstId;
  },
  // Set the text of the CURRENT (trailing) spoken segment. A tool/reasoning part
  // "closes" the segment, so the next liveText starts a fresh text part after it —
  // that's what interleaves speech and tool activity in spoken order.
  liveText(chatId: string, id: string, text: string) {
    patch(chatId, id, (m) => {
      const parts = m.parts.slice();
      const last = parts[parts.length - 1];
      if (last?.kind === "text") { if (last.text === text) return m; parts[parts.length - 1] = { kind: "text", text }; }
      else parts.push({ kind: "text", text });
      return { ...m, parts };
    });
  },
  // Streamed reasoning — appended to the trailing reasoning part (or a new one).
  liveReason(chatId: string, id: string, delta: string) {
    patch(chatId, id, (m) => {
      const parts = m.parts.slice();
      const last = parts[parts.length - 1];
      if (last?.kind === "reasoning") parts[parts.length - 1] = { kind: "reasoning", text: last.text + delta };
      else parts.push({ kind: "reasoning", text: delta });
      return { ...m, parts };
    });
  },
  // Fold a tool event into the assistant turn (ordered where it happened).
  liveEvent(chatId: string, id: string, e: SseEvent) {
    if (e.type === "tool_start") {
      patch(chatId, id, (m) => ({ ...m, parts: [...m.parts, { kind: "tool", id: e.id, tool: e.tool, summary: e.summary, done: false }] }));
    } else if (e.type === "tool_done") {
      patch(chatId, id, (m) => ({
        ...m,
        parts: m.parts.map((p) => (p.kind === "tool" && p.id === e.id ? { ...p, detail: e.detail, done: true } : p)),
      }));
    }
  },
  liveFinish(chatId: string, id: string) {
    patch(chatId, id, (m) =>
      m.done ? m : { ...m, done: true, parts: m.parts.map((p) => (p.kind === "tool" && !p.done ? { ...p, done: true } : p)) },
    );
  },
  // Seed the transcript from saved messages (resuming a conversation), preserving
  // the order text and tools appeared in.
  preload(chatId: string, messages: Array<{ id: string; role: string; content: Array<{ type: string; text?: string; tool?: string }> }>) {
    const msgs: ChatMsg[] = [];
    for (const m of messages) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      if (m.role === "user") {
        const text = m.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
        if (text) msgs.push({ id: m.id, role: "user", text, parts: [], done: true });
        continue;
      }
      const parts: Part[] = [];
      for (const b of m.content) {
        if (b.type === "text" && b.text?.trim()) {
          const last = parts[parts.length - 1];
          if (last?.kind === "text") last.text += b.text;
          else parts.push({ kind: "text", text: b.text });
        } else if (b.type === "tool") {
          parts.push({ kind: "tool", tool: b.tool ?? "", done: true });
        }
      }
      if (parts.length) msgs.push({ id: m.id, role: "assistant", text: "", parts, done: true });
    }
    useChatState.getState()._set(chatId, () => msgs);
  },
  // Like preload, but ONLY if the transcript is still empty. Used by a session/load
  // reload_history refetch: the empty-check + replace is synchronous, so it can't
  // clobber a live turn the user started while the async refetch was in flight.
  preloadIfEmpty(chatId: string, messages: Array<{ id: string; role: string; content: Array<{ type: string; text?: string; tool?: string }> }>) {
    if ((useChatState.getState().byChat[chatId] ?? []).length > 0) return;
    this.preload(chatId, messages);
  },
};

const EMPTY: ChatMsg[] = [];
/** Subscribe a component to a chat's transcript. */
export function useChat(chatId: string): ChatMsg[] {
  return useChatState((s) => s.byChat[chatId] ?? EMPTY);
}
