import { mergeToolCall, type MessageBlock, type SseEvent } from "@openlive/shared";

// Fold one agent event into an ordered MessageBlock[] so a turn replays in order on
// reload. Pure — the live session owns forwarding over the wire + any gating.

/** Per-turn fold state: live terminal output accumulates here (keyed by
 *  terminalId) and is snapshotted into the owning tool call at persist time, so
 *  saved transcripts replay without a live terminal. */
export type FoldCtx = { term: Map<string, { output: string; truncated: boolean; exitCode?: number | null }> };
export const newFoldCtx = (): FoldCtx => ({ term: new Map() });

// Persisted-snapshot cap per terminal (tail kept — the end of a log is what
// explains the exit code). The live UI has its own identical client-side cap.
const TERM_SNAPSHOT_CAP = 128 * 1024;

export function foldBlock(blocks: MessageBlock[], e: SseEvent, ctx?: FoldCtx): void {
  switch (e.type) {
    case "text_delta":
    case "reasoning_delta": {
      const kind = e.type === "text_delta" ? "text" : "reasoning";
      const last = blocks[blocks.length - 1];
      if (last && last.type === kind) last.text += e.text;
      else blocks.push({ type: kind, text: e.text });
      break;
    }
    case "tool_start": blocks.push({ type: "tool", id: e.id, tool: e.tool, summary: e.summary, status: "done" }); break;
    case "tool_done": {
      const t = blocks.find((b) => b.type === "tool" && b.id === e.id);
      if (t && t.type === "tool") t.detail = e.detail;
      break;
    }
    case "acp_tool_call": {
      // Upsert: an agent may re-send a full snapshot for an id it already opened.
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i]!;
        if (b.type === "acp_tool" && b.call.id === e.call.id) { b.call = e.call; return; }
      }
      blocks.push({ type: "acp_tool", call: e.call });
      break;
    }
    case "acp_tool_update": {
      // Scan from the end — recent calls are the ones still updating (Zed parity).
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i]!;
        if (b.type === "acp_tool" && b.call.id === e.delta.id) { b.call = mergeToolCall(b.call, e.delta); return; }
      }
      // An update for a call we never saw → failed placeholder, never a silent drop.
      blocks.push({ type: "acp_tool", call: mergeToolCall(undefined, e.delta) });
      break;
    }
    case "term_output": {
      if (!ctx) break;
      const t = ctx.term.get(e.terminalId) ?? { output: "", truncated: false };
      t.output += e.chunk;
      if (t.output.length > TERM_SNAPSHOT_CAP) { t.output = t.output.slice(-TERM_SNAPSHOT_CAP); t.truncated = true; }
      if (e.truncated) t.truncated = true;
      ctx.term.set(e.terminalId, t);
      break;
    }
    case "term_exit": {
      if (!ctx) break;
      const t = ctx.term.get(e.terminalId) ?? { output: "", truncated: false };
      t.exitCode = e.exitCode ?? null;
      ctx.term.set(e.terminalId, t);
      break;
    }
  }
}

/** Run before persisting a turn: copy captured terminal output into the tool
 *  calls that reference it, and settle statuses a dead turn can't finish
 *  (pending/in_progress → canceled — matches Zed's cancel_pending_turn_entries). */
export function finalizeToolBlocks(blocks: MessageBlock[], ctx: FoldCtx): void {
  for (const b of blocks) {
    if (b.type !== "acp_tool") continue;
    const content = b.call.content.map((c) => {
      if (c.type !== "terminal") return c;
      const t = ctx.term.get(c.terminalId);
      return t ? { ...c, output: t.truncated ? `…${t.output}` : t.output, exitCode: t.exitCode ?? c.exitCode } : c;
    });
    const status = b.call.status === "pending" || b.call.status === "in_progress" ? ("canceled" as const) : b.call.status;
    b.call = { ...b.call, content, status };
  }
}
