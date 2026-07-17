"use client";

import { create } from "zustand";
import { mergeToolCall, type SseEvent, type ToolCallState } from "@openlive/shared";

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
  | { kind: "tool"; id?: string; tool: string; summary?: string; detail?: string; done: boolean }
  // Rich ACP tool call (coding agents) — status/kind/diffs/terminal/raw input.
  | { kind: "acp_tool"; call: ToolCallState };

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
    set((s) => {
      const cur = s.byChat[chatId] ?? [];
      const next = fn(cur);
      return next === cur ? s : { byChat: { ...s.byChat, [chatId]: next } };
    }),
}));

// Identity-preserving: untouched messages keep their object, and a no-op patch
// keeps the ARRAY — so memoized rows skip re-render during per-frame streaming.
function patch(chatId: string, id: string, fn: (m: ChatMsg) => ChatMsg) {
  useChatState.getState()._set(chatId, (msgs) => {
    let changed = false;
    const next = msgs.map((m) => {
      if (m.id !== id) return m;
      const r = fn(m);
      if (r !== m) changed = true;
      return r;
    });
    return changed ? next : msgs;
  });
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
    } else if (e.type === "acp_tool_call") {
      // Upsert by id — an agent may re-send a full snapshot for an open call.
      patch(chatId, id, (m) => upsertAcpTool(m, e.call.id, () => e.call));
    } else if (e.type === "acp_tool_update") {
      patch(chatId, id, (m) => upsertAcpTool(m, e.delta.id, (prev) => mergeToolCall(prev, e.delta)));
    }
  },
  liveFinish(chatId: string, id: string) {
    patch(chatId, id, (m) =>
      m.done ? m : {
        ...m,
        done: true,
        parts: m.parts.map((p) =>
          p.kind === "tool" && !p.done ? { ...p, done: true }
          // A dead turn can't finish its calls — settle, don't spin forever.
          : p.kind === "acp_tool" && (p.call.status === "pending" || p.call.status === "in_progress")
            ? { ...p, call: { ...p.call, status: "canceled" as const } }
          : p),
      },
    );
  },
  // Seed the transcript from saved messages (resuming a conversation), preserving
  // the order text and tools appeared in.
  preload(chatId: string, messages: Array<{ id: string; role: string; content: Array<{ type: string; text?: string; tool?: string; call?: ToolCallState }> }>) {
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
        } else if (b.type === "acp_tool" && b.call) {
          parts.push({ kind: "acp_tool", call: b.call });
        }
      }
      if (parts.length) msgs.push({ id: m.id, role: "assistant", text: "", parts, done: true });
    }
    useChatState.getState()._set(chatId, () => msgs);
  },
  // Like preload, but ONLY if the transcript is still empty. Used by a session/load
  // reload_history refetch: the empty-check + replace is synchronous, so it can't
  // clobber a live turn the user started while the async refetch was in flight.
  preloadIfEmpty(chatId: string, messages: Array<{ id: string; role: string; content: Array<{ type: string; text?: string; tool?: string; call?: ToolCallState }> }>) {
    if ((useChatState.getState().byChat[chatId] ?? []).length > 0) return;
    this.preload(chatId, messages);
  },
};

/** Replace-or-append the acp_tool part with this id (scanning from the end —
 *  recent calls are the live ones). Returns a new message object. */
function upsertAcpTool(m: ChatMsg, id: string, next: (prev?: ToolCallState) => ToolCallState): ChatMsg {
  const parts = m.parts.slice();
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]!;
    if (p.kind === "acp_tool" && p.call.id === id) {
      parts[i] = { kind: "acp_tool", call: next(p.call) };
      return { ...m, parts };
    }
  }
  parts.push({ kind: "acp_tool", call: next(undefined) });
  return { ...m, parts };
}

const EMPTY: ChatMsg[] = [];
/** Subscribe a component to a chat's transcript. */
export function useChat(chatId: string): ChatMsg[] {
  return useChatState((s) => s.byChat[chatId] ?? EMPTY);
}
