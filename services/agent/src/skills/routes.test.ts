import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "ol-skill-routes-"));
const userDir = join(dir, "skills");
process.env.OPENLIVE_HOME = join(dir, "home");
process.env.OPENLIVE_SKILLS_DIR = userDir;
const { skillRoutes } = await import("./routes.ts");

afterAll(() => {
  delete process.env.OPENLIVE_HOME;
  delete process.env.OPENLIVE_SKILLS_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const call = async (method: string, path: string, body?: unknown) => {
  const r = await skillRoutes.request(path, { method, headers: { "content-type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }) });
  return { status: r.status, json: (await r.json()) as any };
};

describe("the /skills API", () => {
  it("lists nothing, with the folder it reads", async () => {
    expect((await call("GET", "/")).json).toEqual({ dir: userDir, skills: [], problems: [] });
  });

  it("creates a skill, refusing a name the spec does not allow", async () => {
    expect((await call("POST", "/", { name: "Bad Name", description: "x" })).status).toBe(400);
    expect((await call("POST", "/", { name: "notes", description: "" })).status).toBe(400);
    const r = await call("POST", "/", { name: "notes", description: "Take notes: in the house style.", body: "# Notes\nBe brief." });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ name: "notes", description: "Take notes: in the house style.", source: "user", enabled: true, resources: 0, warnings: [] });
    expect((await call("POST", "/", { name: "notes", description: "again" })).status).toBe(409);
  });

  it("returns SKILL.md and saves an edit, keeping the name", async () => {
    const got = await call("GET", "/skill/notes");
    expect(got.json.text).toContain("Be brief.");
    const edited = got.json.text.replace("Be brief.", "Be very brief.");
    expect((await call("PUT", "/skill/notes", { text: edited.replace("name: notes", "name: other") })).status).toBe(400);
    expect((await call("PUT", "/skill/notes", { text: "no frontmatter" })).status).toBe(400);
    expect((await call("PUT", "/skill/notes", { text: edited })).status).toBe(200);
    expect(readFileSync(join(userDir, "notes", "SKILL.md"), "utf8")).toContain("Be very brief.");
  });

  it("switches a skill off and on, and lists a workspace's skills read-only", async () => {
    expect((await call("POST", "/skill/notes/enabled", { enabled: false })).json.enabled).toBe(false);
    expect((await call("GET", "/")).json.skills[0].enabled).toBe(false);
    expect((await call("POST", "/skill/notes/enabled", { enabled: true })).json.enabled).toBe(true);
    const ws = join(dir, "project");
    mkdirSync(join(ws, ".agents", "skills", "lint"), { recursive: true });
    writeFileSync(join(ws, ".agents", "skills", "lint", "SKILL.md"), "---\nname: lint\ndescription: Lint it.\n---\nRun the linter.");
    const q = `?workspace=${encodeURIComponent(ws)}`;
    expect((await call("GET", `/${q}`)).json.skills.map((s: any) => [s.name, s.source])).toEqual([["lint", "workspace"], ["notes", "user"]]);
    expect((await call("DELETE", `/skill/lint${q}`)).status).toBe(404);
  });

  it("reveals the folder and removes a skill", async () => {
    expect((await call("POST", "/reveal")).json).toEqual({ path: userDir });
    expect((await call("DELETE", "/skill/notes")).status).toBe(200);
    expect((await call("POST", "/rescan")).json.skills).toEqual([]);
    expect((await call("POST", "/import", { items: [] })).status).toBe(400);
  });
});
