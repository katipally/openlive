import type { AgentCommandWire, SkillWire } from "@openlive/shared";

// The typed composer's rules, kept pure so they are unit-tested: when the
// slash menu is open and for what, which commands match, when a typed
// "/name " becomes a command chip, which files attach, and the text a send
// puts on the wire (ACP wants a command as "/name args").

/** An agent's command, or an OpenLive skill, which a typed "/name" loads. */
export type Command = AgentCommandWire & { skill?: true };

export const MAX_ATTACHMENTS = 4;
// Past this an image is a photo library export, not a screenshot; it would be
// decoded in full before it is scaled down.
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/** The command name being typed: the whole draft is "/" plus a word, no space
 *  yet. Null when the draft is anything else, so "/" mid-sentence is just text. */
export function slashQuery(draft: string): string | null {
  const m = /^\/(\S*)$/.exec(draft);
  return m ? m[1]! : null;
}

/** The agent's commands, then the enabled skills. A skill named like a command
 *  is left out: the server sends that name to the agent, as typed. O(commands + skills). */
export function withSkills(commands: Command[], skills: readonly Pick<SkillWire, "name" | "description" | "enabled">[]): Command[] {
  const taken = new Set(commands.map((c) => c.name));
  const extra = skills.filter((s) => s.enabled && !taken.has(s.name)).map((s) => ({ name: s.name, description: s.description, skill: true as const }));
  return extra.length ? [...commands, ...extra] : commands;
}

/** Commands matching `query`, best first: name prefix, then name contains, then
 *  description contains. Case-insensitive, stable within a rank, O(commands). */
export function filterCommands(commands: Command[], query: string): Command[] {
  const q = query.toLowerCase();
  if (!q) return commands;
  const prefix: Command[] = [], within: Command[] = [], described: Command[] = [];
  for (const c of commands) {
    const name = c.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(c);
    else if (name.includes(q)) within.push(c);
    else if (c.description.toLowerCase().includes(q)) described.push(c);
  }
  return [...prefix, ...within, ...described];
}

/** A draft that starts with a whole advertised command and a space ("/review
 *  main") becomes the command's chip plus the rest as its arguments. */
export function promoteCommand(draft: string, commands: Command[]): { command: Command; rest: string } | null {
  const m = /^\/(\S+)\s([\s\S]*)$/.exec(draft);
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  const command = commands.find((c) => c.name.toLowerCase() === name);
  return command ? { command, rest: m[2]! } : null;
}

/** What a send puts on the wire: "/name args" for a command, else the text.
 *  Images sent without words still need a turn's text, so it says what came. */
export function composeMessage(command: Command | null, text: string, images = 0): string {
  const body = text.trim();
  if (command) return body ? `/${command.name} ${body}` : `/${command.name}`;
  return body || (images ? `(${images === 1 ? "an image" : `${images} images`} attached)` : "");
}

type FileLike = { name: string; type: string; size: number };

/** Split picked, pasted or dropped files into the ones that attach and the ones
 *  that don't, with a reason a person can act on. Images only: that is what
 *  every brain can take (directly, or through the vision model). */
export function acceptFiles<F extends FileLike>(have: number, files: F[]): { accepted: F[]; rejected: { name: string; reason: string }[] } {
  const accepted: F[] = [];
  const rejected: { name: string; reason: string }[] = [];
  for (const f of files) {
    if (!f.type.startsWith("image/")) rejected.push({ name: f.name, reason: "Only images can be attached." });
    else if (f.size > MAX_IMAGE_BYTES) rejected.push({ name: f.name, reason: "That image is too large." });
    else if (have + accepted.length >= MAX_ATTACHMENTS) rejected.push({ name: f.name, reason: `Up to ${MAX_ATTACHMENTS} images per message.` });
    else accepted.push(f);
  }
  return { accepted, rejected };
}
