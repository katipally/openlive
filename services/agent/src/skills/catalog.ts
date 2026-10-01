import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { skillsDir } from "@openlive/db";
import type { SkillSource } from "@openlive/shared";
import { parseSkill, type Parsed, type Skill } from "./parse.js";

// Finding skills: OpenLive's own folder, and a bound workspace's
// .agents/skills and .claude/skills, read in place and never copied. A scan
// stats every SKILL.md and parses only the ones that changed, so running one
// at every session start costs a stat per skill.

export interface SkillEntry extends Skill {
  /** The skill's folder, absolute. */
  dir: string;
  file: string;
  source: SkillSource;
  warnings: string[];
}

export interface SkillProblem { dir: string; source: SkillSource; error: string }

export interface Catalog { skills: SkillEntry[]; problems: SkillProblem[] }

/** Parsed SKILL.md files by path, with the mtime and size they were parsed at. */
const cache = new Map<string, { mtimeMs: number; size: number; parsed: Parsed }>();

/** Forget every parse, for a rescan the person asked for. */
export function rescan(): void { cache.clear(); }

/** One SKILL.md, parsed again only when it changed. Null when it is gone. */
export function load(file: string): Parsed | null {
  let st;
  try { st = statSync(file); } catch { return null; }
  if (!st.isFile()) return null;
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.parsed;
  let parsed: Parsed;
  try { parsed = parseSkill(readFileSync(file, "utf8"), basename(dirname(file))); }
  catch (e) { parsed = { ok: false, error: `Could not read it: ${e instanceof Error ? e.message : String(e)}` }; }
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, parsed });
  return parsed;
}

const hidden = (name: string) => name.startsWith(".") || name === "node_modules";

/**
 * Every skill folder directly under `root`, by name. A folder without a
 * SKILL.md is not a skill and is passed over in silence; one whose SKILL.md
 * cannot load is a problem the UI shows. O(folders) stats, plus a parse per
 * changed file.
 */
export function scanRoot(root: string, source: SkillSource): Catalog {
  const out: Catalog = { skills: [], problems: [] };
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (hidden(e.name) || !(e.isDirectory() || e.isSymbolicLink())) continue;
    const dir = join(root, e.name);
    const parsed = load(join(dir, "SKILL.md"));
    if (!parsed) continue;
    if (!parsed.ok) { out.problems.push({ dir, source, error: parsed.error }); continue; }
    out.skills.push({ ...parsed.skill, dir, file: join(dir, "SKILL.md"), source, warnings: [...parsed.warnings] });
  }
  return out;
}

/** Where skills are read from, lowest precedence first. */
export function skillRoots(workspace = ""): [string, SkillSource][] {
  const roots: [string, SkillSource][] = [[skillsDir(), "user"]];
  // .agents/skills is the cross-client folder, so it wins over .claude/skills in the same workspace.
  if (workspace.trim()) roots.push([join(workspace, ".claude", "skills"), "workspace"], [join(workspace, ".agents", "skills"), "workspace"]);
  return roots;
}

/**
 * Every skill this session can see, one per name, sorted by name. A later
 * root wins a name: a workspace skill overrides the user's skill of the same
 * name, and the one it shadows is named in a warning. O(n log n) in skills.
 */
export function catalog(workspace = ""): Catalog {
  const byName = new Map<string, SkillEntry>();
  const problems: SkillProblem[] = [];
  for (const [root, source] of skillRoots(workspace)) {
    const found = scanRoot(root, source);
    problems.push(...found.problems);
    for (const s of found.skills) {
      const prev = byName.get(s.name);
      if (prev) s.warnings.push(`It overrides the skill of the same name in ${prev.dir}.`);
      byName.set(s.name, s);
    }
  }
  return { skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), problems };
}

const RESOURCE_DEPTH = 4;
export const RESOURCE_MAX = 200;

/**
 * The files beside SKILL.md, as relative paths with forward slashes on every
 * OS, listed and never read. Bounded in depth and count, so a skill that ships
 * a whole tree costs no more than a page. O(entries visited).
 */
export function resources(dir: string): { files: string[]; more: boolean } {
  const files: string[] = [];
  let more = false;
  const walk = (at: string, depth: number) => {
    let entries;
    try { entries = readdirSync(at, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (more || hidden(e.name)) continue;
      const abs = join(at, e.name);
      if (e.isDirectory()) { if (depth < RESOURCE_DEPTH) walk(abs, depth + 1); continue; }
      if (depth === 0 && e.name === "SKILL.md") continue;
      if (files.length >= RESOURCE_MAX) { more = true; continue; }
      files.push(relative(dir, abs).split(sep).join("/"));
    }
  };
  walk(dir, 0);
  return { files, more };
}
