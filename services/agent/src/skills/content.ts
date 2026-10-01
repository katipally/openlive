import type { Message } from "@openlive/harness";

// An activated skill as the model reads it, and how a compaction keeps it.
// The tags are what lets a loop find skill instructions in a transcript.

const BLOCK = /<skill_content name="([^"]+)">[\s\S]*?\n<\/skill_content>/g;

/** Text safe inside the tags. */
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The heading a compaction puts before the skills it carries over. */
export const CARRIED_HEAD = "Skills activated earlier, still in force:";

/**
 * The skill's instructions, where it lives, and its files listed but not read,
 * in the wrapping the client guide suggests.
 */
export function skillContent(name: string, body: string, dir: string, files: { files: string[]; more: boolean }): string {
  const listed = files.files.length
    ? `\n\n<skill_resources>\n${files.files.map((f) => `  <file>${esc(f)}</file>`).join("\n")}${files.more ? "\n  <!-- more files not listed -->" : ""}\n</skill_resources>`
    : "";
  return `<skill_content name="${name}">\n${body}\n\nSkill directory: ${dir}\nRelative paths in this skill are relative to that directory. Read a file with read_skill_file. Run a script with your shell tool, from that directory, where you have one.${listed}\n</skill_content>`;
}

/**
 * The skill instructions in what a compaction drops, so they ride along: an
 * activated skill is standing guidance, and losing it mid-conversation degrades
 * the model with no visible error. A skill also in what is kept is left out,
 * and a repeat keeps its latest copy. O(total text).
 */
export function carriedSkills(dropped: readonly Message[], kept: readonly Message[]): string {
  const textOf = (m: Message) => (m.role === "tool" ? m.result : m.text ?? "");
  const keptNames = new Set(kept.flatMap((k) => [...textOf(k).matchAll(BLOCK)].map((m) => m[1]!)));
  const out = new Map<string, string>();
  for (const d of dropped) for (const m of textOf(d).matchAll(BLOCK)) if (!keptNames.has(m[1]!)) out.set(m[1]!, m[0]);
  return [...out.values()].join("\n\n");
}
