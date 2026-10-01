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
  description: "Hand off anything that needs the web — a search, a lookup, reading a page, checking a current fact — to your assistant, who has those tools. Give the task in one clear line. Say a short natural line to the user FIRST ('let me look that up'), then delegate: your assistant works while you talk, and reports back what it found for you to relay. Don't delegate things you already know — answer those instantly.",
  parameters: params({ task: z.string().describe("The lookup/research task, in one line") }),
  readOnly: true,
  promptGuidelines: [
    "You have an assistant who owns the web tools — you don't search yourself, you hand work off with `delegate` (give the task in one clear line).",
    "DELEGATE whenever the answer depends on the real world right now or on facts you can't be sure of: weather, news, prices, scores, schedules, \"latest / current / today / who won / what's happening\", any specific number or fact you'd otherwise be guessing at, OR any time the user asks you to look something up or use a tool. When in doubt between guessing and checking — CHECK. A wrong confident answer is worse than a short pause.",
    "Don't delegate what's genuinely stable and you plainly know (the capital of France, simple math, today's date — you're given that above). Answer those instantly.",
    "ALWAYS say one short, natural line to the user FIRST, THEN delegate — \"yeah, let me look that up\", \"one sec, checking that\". Your voice fills the wait; they can see your assistant working. When it reports back, tell them what it found, plainly and short.",
  ],
  async execute(args, ctx) {
    const task = String(args.task ?? "").trim();
    if (!task) return text("No task given.");
    return text((await runWorker(task, ctx.emit ?? (() => {}), ctx.signal)) || "(no findings)");
  },
};

const updateTodos: Tool<{ items: { text: string; done: boolean }[] }, null> = {
  name: "update_todos",
  description: "Publish/update a short checklist (3+ steps) shown in the UI; mark items done as you go. Skip for simple answers.",
  parameters: params({ items: z.array(z.object({ text: z.string(), done: z.boolean() })).min(1).max(8) }),
  promptGuidelines: ["`update_todos` — a multi-step task checklist."],
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
  description: "Save a short fact worth keeping across turns and future calls — the user's name, a preference, an ongoing goal. Use sparingly, one clear fact at a time. You'll automatically know remembered facts next time.",
  parameters: params({ note: z.string().describe("The fact to remember, as one short sentence") }),
  promptGuidelines: ["`remember` — save a lasting fact about the user."],
  async execute(args) {
    try {
      const r = await addNote(String(args.note ?? ""));
      if (!r.ok) return text({ empty: "Nothing to remember.", duplicate: "Already remembered.", full: "Memory is full. Tell the user to delete some notes in Settings, Memory." }[r.reason]);
    } catch { /* best-effort */ }
    return text("Got it — I'll remember that.");
  },
};

// Distinct from `screenshot` on purpose: this is the frame a call is already
// sharing, camera or screen, with nothing to point at in it; screenshot is a
// capture of the machine's own display, sized for the coordinates control takes.
const look: Tool<Record<string, never>, null> = {
  name: "look",
  readOnly: true,
  description: "Capture a fresh, higher-resolution frame from the user's camera and see it right now. Use when you need a closer or more current look at what the user is showing you. If the camera is off this returns nothing — then ask the user to turn it on.",
  parameters: noParams,
  promptGuidelines: ["Need a closer or sharper look — to read a small label, a serial, a setting? Call `look`; it grabs a crisper current frame. Nothing shared and you need to see? Ask them to turn on their camera or share their screen."],
  available: (s) => !!s.share,
  async execute(_args, ctx) {
    const showing = ctx.share!.showing();
    if (!showing) return text("Nothing is being shared right now. Ask the user to turn on their camera or share their screen.");
    const frame = await ctx.share!.frame();
    if (!frame) return text("Couldn't grab a fresh frame (it timed out). Ask the user to check their camera / screen share.");
    return {
      content: [{ type: "text", text: `This is what the user's ${showing} is showing right now — talk about it naturally, as what you're both looking at.` }, { type: "image", ...frame }],
      details: null,
    };
  },
};

export const ASSISTANT_TOOLS: Tool[] = [delegate, updateTodos, remember, look];
