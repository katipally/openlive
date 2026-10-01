import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { stringify } from "yaml";
import { z } from "zod";
import { disabledSkills, setSkillEnabled, skillsDir } from "@openlive/db";
import { SKILL_DESCRIPTION_MAX, skillNameProblem, type SkillListWire, type SkillWire } from "@openlive/shared";
import { bundledSkillsDir, catalog, rescan, resources, scanRoot, type SkillEntry } from "./catalog.js";
import { parseSkill } from "./parse.js";
import { copySkill, previewSkills, skillImportSources } from "./import.js";

// The /skills REST surface, behind the agent's shared-secret gate. OpenLive's
// own skills can be created, edited and removed; a workspace's are listed for
// a `?workspace=` folder and only ever read, as are the built-in ones. One
// skill's routes sit under /skill/:name, because a skill may well be named "import".

export const skillRoutes = new Hono();

const wire = (s: SkillEntry, off: Set<string>, replacedBy?: SkillWire["replacedBy"]): SkillWire => ({
  name: s.name, description: s.description, source: s.source, dir: s.dir, enabled: !off.has(s.name),
  resources: resources(s.dir).files.length, warnings: s.warnings,
  ...(s.license && { license: s.license }), ...(s.compatibility && { compatibility: s.compatibility }),
  ...(replacedBy && { replacedBy }),
});

function list(workspace = ""): SkillListWire {
  const off = disabledSkills();
  const { skills, problems, replaced } = catalog(workspace);
  const winner = new Map(skills.map((s) => [s.name, s.source]));
  return {
    dir: skillsDir(),
    skills: [...skills.map((s) => wire(s, off)), ...replaced.map((s) => wire(s, off, winner.get(s.name) as SkillWire["replacedBy"]))],
    problems,
  };
}

const workspaceOf = (c: { req: { query(k: string): string | undefined } }) => c.req.query("workspace") ?? "";
/** OpenLive's own skill by name, the only kind these routes change. */
const own = (name: string) => scanRoot(skillsDir(), "user").skills.find((s) => s.name === name);
/** A skill OpenLive ships, by name. */
export const builtIn = (name: string) => scanRoot(bundledSkillsDir(), "bundled").skills.find((s) => s.name === name);
const locked = (name: string, what: string) =>
  `${name} is built into OpenLive, so it cannot be ${what}. Turn it off instead, or make a skill of your own named ${name} to replace it.`;

async function body<T>(c: { req: { json(): Promise<unknown> } }, schema: z.ZodType<T>): Promise<T | null> {
  try { const r = schema.safeParse(await c.req.json()); return r.success ? r.data : null; }
  catch { return null; }
}

/** Write a file whole or not at all. The parse cache is dropped, since a rewrite inside one mtime tick of the same size would look unchanged. */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
  rescan();
}

skillRoutes.get("/", (c) => c.json(list(workspaceOf(c))));

skillRoutes.post("/rescan", (c) => { rescan(); return c.json(list(workspaceOf(c))); });

// The folder, made if it is not there yet, for the desktop to open.
skillRoutes.post("/reveal", (c) => {
  mkdirSync(skillsDir(), { recursive: true });
  return c.json({ path: skillsDir() });
});

const createSchema = z.object({ name: z.string(), description: z.string(), body: z.string().default("") });

/** What stops a new skill before anything is written, or "". */
export function newSkillProblem(name: string, description: string): string {
  const bad = skillNameProblem(name);
  if (bad) return bad;
  if (!description) return "Describe what it does and when to use it.";
  if (description.length > SKILL_DESCRIPTION_MAX) return `A description is at most ${SKILL_DESCRIPTION_MAX} characters.`;
  return "";
}

/** A new skill in OpenLive's own folder, for this route and the save_skill tool. */
export function createSkill(raw: { name: string; description: string; body: string }): { skill: SkillWire } | { error: string; status: 400 | 409 | 500 } {
  const name = raw.name.trim(), description = raw.description.trim();
  const bad = newSkillProblem(name, description);
  if (bad) return { error: bad, status: 400 };
  mkdirSync(skillsDir(), { recursive: true });
  const dir = join(skillsDir(), name);
  try { mkdirSync(dir); }
  catch { return { error: `There is already a folder named ${name}.`, status: 409 }; }
  writeAtomic(join(dir, "SKILL.md"), `---\n${stringify({ name, description }, { lineWidth: 0 })}---\n\n${raw.body.trim()}\n`);
  const made = own(name);
  return made ? { skill: wire(made, disabledSkills()) } : { error: "It was written but does not load.", status: 500 };
}

skillRoutes.post("/", async (c) => {
  const b = await body(c, createSchema);
  if (!b) return c.json({ error: "send { name, description, body }" }, 400);
  const r = createSkill(b);
  return "skill" in r ? c.json(r.skill, 201) : c.json({ error: r.error }, r.status);
});

// `?source=bundled` reads the built-in skill even where one of yours replaces it.
skillRoutes.get("/skill/:name", (c) => {
  const name = c.req.param("name");
  const s = c.req.query("source") === "bundled" ? builtIn(name) : catalog(workspaceOf(c)).skills.find((k) => k.name === name);
  if (!s) return c.json({ error: "not found" }, 404);
  let text: string;
  try { text = readFileSync(s.file, "utf8"); } catch { return c.json({ error: "not found" }, 404); }
  return c.json({ skill: wire(s, disabledSkills()), text });
});

// The whole SKILL.md, frontmatter and body. Its name must stay its folder's.
skillRoutes.put("/skill/:name", async (c) => {
  const name = c.req.param("name");
  const b = await body(c, z.object({ text: z.string() }));
  if (!b) return c.json({ error: "send { text }" }, 400);
  const s = own(name);
  if (!s) return builtIn(name) ? c.json({ error: locked(name, "edited") }, 403) : c.json({ error: "not found" }, 404);
  const parsed = parseSkill(b.text, name);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  if (parsed.skill.name !== name) return c.json({ error: `Keep the name "${name}": it is the folder's name.` }, 400);
  writeAtomic(s.file, b.text);
  return c.json(wire(own(name)!, disabledSkills()));
});

skillRoutes.post("/skill/:name/enabled", async (c) => {
  const b = await body(c, z.object({ enabled: z.boolean() }));
  if (!b) return c.json({ error: "send { enabled }" }, 400);
  const name = c.req.param("name");
  const s = catalog(workspaceOf(c)).skills.find((k) => k.name === name);
  if (!s) return c.json({ error: "not found" }, 404);
  await setSkillEnabled(name, b.enabled);
  return c.json(wire(s, disabledSkills()));
});

skillRoutes.delete("/skill/:name", async (c) => {
  const name = c.req.param("name");
  const s = own(name);
  if (!s) return builtIn(name) ? c.json({ error: locked(name, "removed") }, 403) : c.json({ error: "not found" }, 404);
  // A linked folder loses the link, never what it points to.
  if (lstatSync(s.dir).isSymbolicLink()) unlinkSync(s.dir);
  else rmSync(s.dir, { recursive: true, force: true });
  await setSkillEnabled(name, true);
  return c.json({ ok: true });
});

// ── import ──────────────────────────────────────────────────────────────────

skillRoutes.get("/import", (c) => c.json({ sources: previewSkills(skillImportSources()) }));

// Commit names what to bring over; the folders are found again on disk here.
skillRoutes.post("/import", async (c) => {
  const b = await body(c, z.object({ items: z.array(z.object({ source: z.string(), name: z.string() })).min(1) }));
  if (!b) return c.json({ error: "send { items: [{ source, name }] }" }, 400);
  const sources = skillImportSources();
  const imported: string[] = [];
  const skipped: { source: string; name: string; reason: string }[] = [];
  for (const item of b.items) {
    const spec = sources.find((s) => s.id === item.source);
    const s = spec && scanRoot(spec.path, "user").skills.find((k) => k.name === item.name);
    if (!s) { skipped.push({ ...item, reason: "not found" }); continue; }
    try { await copySkill(s); imported.push(s.name); }
    catch (e) { skipped.push({ ...item, reason: e instanceof Error ? e.message : String(e) }); }
  }
  return c.json({ imported, skipped }, 201);
});
