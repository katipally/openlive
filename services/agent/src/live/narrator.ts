import { basename } from "node:path";
import type { Emit } from "../tools.js";

// Spoken progress for ACP agent turns. Long tool runs are dead air in a voice
// call — this wraps the turn's Emit and injects a short text_delta one-liner
// ("Step 2 of 4 — refactor the session store.") when a tool has been running
// for a while and the agent hasn't said anything itself. Same mechanism as the
// built-in brain's worker narration (worker.ts): the line rides text_delta, so
// the client speaks it through the normal chunker with barge-in epochs intact.
//
// Guards: fires 1.5s into a tool call, only if no reply text has streamed since
// that tool started, at most 4 lines a turn, at least 8s apart, never after abort.

const ARM_MS = 1500;
const MIN_GAP_MS = 8000;
const MAX_LINES = 4;

/** Narration is ON unless the user explicitly turned it off ("0"). The legacy
 *  values ("" = never touched, "1" = explicitly on) both mean enabled. */
export const narrationEnabled = (v: string | undefined | null): boolean => v !== "0";

export function wrapEmitWithNarration(emit: Emit, signal: AbortSignal): Emit {
  let todos: { text: string; done: boolean }[] = [];
  let textSinceToolStart = false;
  let lastLineAt = 0;
  let lines = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const line = (toolLabel: string): string => {
    const undone = todos.findIndex((t) => !t.done);
    if (undone >= 0) return ` Step ${undone + 1} of ${todos.length} — ${todos[undone]!.text.replace(/\.$/, "")}.`;
    // Tool labels arrive as "title · /abs/path" — speak just the basename.
    const [title, path] = toolLabel.split(" · ");
    return ` ${title}${path ? ` — ${basename(path)}` : ""} now.`;
  };

  return async (e) => {
    if (e.type === "text_delta") { textSinceToolStart = true; clearTimeout(timer); }
    if (e.type === "todos") todos = e.items;
    // Legacy tool_start (built-in brain) and rich acp_tool_call both arm the timer.
    if (e.type === "tool_start" || e.type === "acp_tool_call") {
      textSinceToolStart = false;
      clearTimeout(timer);
      const label = e.type === "tool_start"
        ? e.tool
        : `${e.call.title}${e.call.locations[0]?.path ? ` · ${e.call.locations[0].path}` : ""}`;
      timer = setTimeout(() => {
        if (signal.aborted || textSinceToolStart || lines >= MAX_LINES || Date.now() - lastLineAt < MIN_GAP_MS) return;
        lines++; lastLineAt = Date.now();
        // Leading space + trailing period → the SentenceChunker treats it as a
        // complete standalone sentence; it can't splice into a real reply.
        void emit({ type: "text_delta", text: line(label) });
      }, ARM_MS);
      if (typeof timer.unref === "function") timer.unref();
    }
    await emit(e);
  };
}
