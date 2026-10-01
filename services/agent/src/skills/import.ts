import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { cp, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { skillsDir } from "@openlive/db";
import type { SkillImportSource, SkillImportSourceId } from "@openlive/shared";
import { catalog, scanRoot, type SkillEntry } from "./catalog.js";

// Bringing skills over from the other tools on this machine, by copying their
// folders into OpenLive's. Copied, never linked, so OpenLive never writes into
// another tool's folder and an edit on either side stays on that side. Each
// tool keeps its skills at the same place under the home folder on every OS
// (os.homedir() is %USERPROFILE% on Windows), checked 2026-10-01: Codex reads
// ~/.agents/skills now and still reads ~/.codex/skills, Gemini CLI reads both
// ~/.gemini/skills and ~/.agents/skills.

type Env = Record<string, string | undefined>;

export interface SkillSourceSpec { id: SkillImportSourceId; label: string; path: string }

export function skillImportSources(env: Env = process.env, home: string = homedir()): SkillSourceSpec[] {
  return [
    { id: "claude-code", label: "Claude Code", path: join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "skills") },
    { id: "agents", label: "Shared (~/.agents)", path: join(home, ".agents", "skills") },
    { id: "codex", label: "Codex", path: join(env.CODEX_HOME || join(home, ".codex"), "skills") },
    { id: "gemini", label: "Gemini CLI", path: join(home, ".gemini", "skills") },
  ];
}

/**
 * Every source's skills, each marked when OpenLive already has one by that
 * name or an earlier source offers it. O(skills) with a map of names taken.
 */
export function previewSkills(sources: SkillSourceSpec[]): SkillImportSource[] {
  const taken = new Map(catalog().skills.map((s) => [s.name, "your OpenLive skills"]));
  return sources.map((spec) => {
    const found = scanRoot(spec.path, "user");
    return {
      source: spec.id, label: spec.label, path: spec.path, found: existsSync(spec.path),
      problems: found.problems.map(({ dir, error }) => ({ dir, error })),
      skills: found.skills.map((s) => {
        const duplicateOf = taken.get(s.name);
        if (!duplicateOf) taken.set(s.name, spec.label);
        return { name: s.name, description: s.description, warnings: s.warnings, ...(duplicateOf && { duplicateOf }) };
      }),
    };
  });
}

const SKIP = new Set([".git", "node_modules"]);

/**
 * Copy one skill's folder in under its name. It lands in a hidden folder
 * first and is renamed into place, so a copy that fails halfway leaves
 * nothing a scan would pick up. Symlinks are copied as what they point to.
 */
export async function copySkill(s: SkillEntry): Promise<void> {
  const root = skillsDir();
  mkdirSync(root, { recursive: true });
  const dest = join(root, s.name);
  if (existsSync(dest)) throw new Error("already added");
  const staging = join(root, `.import-${randomUUID()}`);
  try {
    await cp(s.dir, staging, { recursive: true, dereference: true, filter: (src) => !SKIP.has(basename(src)) });
    await rename(staging, dest);
  } catch (e) {
    await rm(staging, { recursive: true, force: true });
    throw e;
  }
}
