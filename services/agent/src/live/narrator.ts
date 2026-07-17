import type { Emit } from "../tools.js";
import type { SseEvent } from "@openlive/shared";

// Spoken progress for a voice turn — kept CLEAN and agent-agnostic. Two pieces:
//
//   1. wrapEmitWithNarration — long tool runs are dead air in a voice call, so this
//      voices ONE short status line ("Still reading through the files.", "Step 2 of
//      4 — …") when a tool has run a while and nothing else is being said. It rides
//      the out-of-band `say` channel: the client VOICES it but never writes it to the
//      transcript, and it NEVER speaks a raw tool title / shell command (the old bug).
//
//   2. createCommentaryGate — an agent narrates its work as ordinary reply text
//      ("I'm checking the Snake logic now") on the same channel as its final answer.
//      This gate speaks the opening line and the FINAL answer, and reroutes the
//      mid-work commentary between tool calls to the (unspoken) reasoning channel —
//      so speech is just what's intended, for every agent, not a play-by-play.
//
// Guards on the status line: fires 1.5s into a tool call, only if no reply text has
// streamed since that tool started, at most 4 lines a turn, at least 8s apart, never
// after abort.

const ARM_MS = 1500;
const MIN_GAP_MS = 8000;
const MAX_LINES = 4;

// ACP tool-call kind → a clean, spoken status line. Mirrors the client's KIND_META
// verbs but phrased as a standalone "still working" cue. Never the raw command.
const KIND_LINE: Record<string, string> = {
  read: "Still reading through the files.",
  edit: "Making some changes.",
  delete: "Cleaning a few files up.",
  move: "Moving some files around.",
  search: "Still searching.",
  execute: "Running a command.",
  think: "Still thinking it through.",
  fetch: "Looking that up.",
  other: "Still working on it.",
};

/** Narration is ON unless the user explicitly turned it off ("0"). The legacy
 *  values ("" = never touched, "1" = explicitly on) both mean enabled. */
export const narrationEnabled = (v: string | undefined | null): boolean => v !== "0";

export function wrapEmitWithNarration(emit: Emit, signal: AbortSignal): Emit {
  let todos: { text: string; done: boolean }[] = [];
  let textSinceToolStart = false;
  let lastLineAt = 0;
  let lines = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const line = (kind?: string): string => {
    // A live plan reads best as "where are we" — speak the next open step.
    const undone = todos.findIndex((t) => !t.done);
    if (undone >= 0) return `Step ${undone + 1} of ${todos.length} — ${todos[undone]!.text.replace(/\.$/, "")}.`;
    return KIND_LINE[kind ?? "other"] ?? "Still working on it.";
  };

  return async (e) => {
    if (e.type === "text_delta") { textSinceToolStart = true; clearTimeout(timer); }
    if (e.type === "todos") todos = e.items;
    // Legacy tool_start (built-in brain) and rich acp_tool_call both arm the timer.
    if (e.type === "tool_start" || e.type === "acp_tool_call") {
      textSinceToolStart = false;
      clearTimeout(timer);
      const kind = e.type === "acp_tool_call" ? e.call.kind : undefined;
      timer = setTimeout(() => {
        if (signal.aborted || textSinceToolStart || lines >= MAX_LINES || Date.now() - lastLineAt < MIN_GAP_MS) return;
        lines++; lastLineAt = Date.now();
        // `say`: voiced out-of-band by the client, NEVER folded into the reply.
        void emit({ type: "say", text: line(kind) });
      }, ARM_MS);
      if (typeof timer.unref === "function") timer.unref();
    }
    await emit(e);
  };
}

/** The commentary gate. Speech should be the opening line + the final answer only —
 *  not the running play-by-play. So: before the first tool of the turn, reply text is
 *  spoken as it streams (a natural "let me take a look"); after the first tool, reply
 *  text is BUFFERED — each stretch that's followed by another tool is flushed to the
 *  (unspoken) reasoning channel as mid-work commentary, and whatever remains at the
 *  end (`flush()`) is the final answer, spoken. Agent-agnostic: it only reshapes the
 *  text stream, so it works the same for every coding agent and the built-in brain.
 *
 *  `flush()` is called by the session after the agent's turn resolves (a normal ACP
 *  turn's `done` is sent out-of-band, so the gate can't rely on seeing it). It no-ops
 *  after abort, so a barged-in turn never voices a stale buffered answer. */
export function createCommentaryGate(inner: Emit, signal: AbortSignal): { emit: Emit; flush: () => Promise<void> } {
  let sawTool = false;
  let buf = "";
  const flushBufAs = async (type: "reasoning_delta" | "text_delta") => {
    const text = buf;
    buf = "";
    if (text.trim() && !signal.aborted) await inner({ type, text } as SseEvent);
  };
  return {
    emit: async (e) => {
      if (e.type === "text_delta") {
        if (!sawTool) return void (await inner(e)); // opening line — speak as it streams
        buf += e.text;                              // mid/late reply — hold until classified
        return;
      }
      if (e.type === "tool_start" || e.type === "acp_tool_call") {
        await flushBufAs("reasoning_delta"); // text before this tool was commentary
        sawTool = true;
      }
      await inner(e);
    },
    flush: () => flushBufAs("text_delta"), // whatever's left after the last tool = the answer
  };
}
