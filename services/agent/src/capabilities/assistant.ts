import { z } from "zod";
import { addNote } from "../memory/notes.js";
import { runWorker } from "../live/worker.js";
import { params } from "./web.js";
import { noParams } from "./text.js";
import type { Tool, ToolResult } from "./types.js";

// What OpenLive itself does for the user, whatever the mode: research through a
// helper, a checklist, a memory every brain shares, and a look at what a call is
// sharing.

const text = (t: string): ToolResult<null> => ({ content: [{ type: "text", text: t }], details: null });

// The brain the user talks to hands a task to a worker that owns the web tools.
// The worker's tool activity streams to the UI while the brain keeps talking,
// and its findings come back for the brain to say.
const delegate: Tool<{ task: string }, null> = {
  name: "delegate",
  group: "web",
  description: "Hand anything that needs the web (a search, a lookup, reading a page, checking a current fact) to your assistant, who has those tools, as one clear line. It works while you talk and reports back what it found for you to relay.",
  parameters: params({ task: z.string().describe("The lookup/research task, in one line") }),
  readOnly: true,
  promptGuidelines: [
    "You don't search the web yourself: your assistant owns those tools, and you hand it work with `delegate`.",
    "DELEGATE whenever the answer depends on the real world right now or on a fact you'd otherwise guess: weather, news, prices, scores, schedules, who won, what's happening, any specific number. Also whenever the user asks you to look something up. When in doubt between guessing and checking, CHECK: a wrong confident answer is worse than a short pause.",
    "Don't delegate what's stable and you plainly know (the capital of France, simple math, today's date, which you're given). Answer those instantly.",
    "ALWAYS say one short, natural line FIRST (\"yeah, let me look that up\"), THEN delegate. Your voice fills the wait while they watch your assistant work. When it reports back, tell them what it found, plainly and short.",
  ],
  async execute(args, ctx) {
    const task = String(args.task ?? "").trim();
    if (!task) return text("No task given.");
    return text((await runWorker(task, ctx.emit ?? (() => {}), ctx.signal)) || "(no findings)");
  },
};

const updateTodos: Tool<{ items: { text: string; done: boolean }[] }, null> = {
  name: "update_todos",
  group: "assistant",
  description: "Publish/update a short checklist (3+ steps) shown in the UI; mark items done as you go. Skip for simple answers.",
  parameters: params({ items: z.array(z.object({ text: z.string(), done: z.boolean() })).min(1).max(8) }),
  promptGuidelines: ["`update_todos`: a checklist for a multi-step task."],
  async execute(args, ctx) {
    const items = Array.isArray(args?.items) ? args.items.map((i) => ({ text: String(i?.text ?? ""), done: !!i?.done })).filter((i) => i.text) : [];
    await ctx.emit?.({ type: "todos", items });
    return text("Checklist updated.");
  },
};

// Lightweight persistent memory: append a fact to the notes every brain's
// prompt carries from the next turn on (see rememberedNotes).
const remember: Tool<{ note: string }, null> = {
  name: "remember",
  group: "assistant",
  description: "Save a short fact worth keeping across turns and future calls: the user's name, a preference, an ongoing goal. Use sparingly, one clear fact at a time. You'll know remembered facts next time.",
  parameters: params({ note: z.string().describe("The fact to remember, as one short sentence") }),
  promptGuidelines: ["`remember`: save a lasting fact about the user."],
  async execute(args) {
    try {
      const r = await addNote(String(args.note ?? ""));
      if (!r.ok) return text({ empty: "Nothing to remember.", duplicate: "Already remembered.", full: "Memory is full. Tell the user to delete some notes in Settings, Memory." }[r.reason]);
    } catch { /* best-effort */ }
    return text("Remembered.");
  },
};

// Distinct from `screenshot` on purpose: this is the frame a call is already
// sharing, camera or screen, with nothing to point at in it; screenshot is a
// capture of the machine's own display, sized for the coordinates control takes.
const look: Tool<Record<string, never>, null> = {
  name: "look",
  group: "assistant",
  readOnly: true,
  description: "A fresh, higher-resolution frame of what the user is sharing (camera or screen), for a closer or more current look. With nothing shared it returns nothing: ask them to turn on their camera or share their screen.",
  parameters: noParams,
  promptGuidelines: ["Need a sharper look, to read a small label, a serial, a setting? Call `look`. Nothing shared and you need to see? Ask them to turn on their camera or share their screen."],
  available: (s) => !!s.share,
  async execute(_args, ctx) {
    const showing = ctx.share!.showing();
    if (!showing) return text("Nothing is being shared right now. Ask the user to turn on their camera or share their screen.");
    const frame = await ctx.share!.frame();
    if (!frame) return text("No fresh frame: it timed out. Ask the user to check their camera or screen share.");
    return {
      content: [{ type: "text", text: `The user's ${showing}, right now. Talk about it as what you're both looking at.` }, { type: "image", ...frame }],
      details: null,
    };
  },
};

export const ASSISTANT_TOOLS: Tool[] = [delegate, updateTodos, remember, look];
