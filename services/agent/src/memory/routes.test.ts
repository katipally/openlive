import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "ol-memory-routes-"));
process.env.OPENLIVE_DATA_DIR = dir;
const { getSetting, setSetting } = await import("@openlive/db");
const { memoryRoutes } = await import("./routes.ts");

afterAll(() => {
  delete process.env.OPENLIVE_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const call = async (method: string, path: string, body?: unknown) => {
  const r = await memoryRoutes.request(path, { method, headers: { "content-type": "application/json" }, ...(body !== undefined && { body: typeof body === "string" ? body : JSON.stringify(body) }) });
  return { status: r.status, json: (await r.json()) as any };
};

describe("the /memory API", () => {
  it("lists nothing, with the budget", async () => {
    expect(await call("GET", "/")).toEqual({ status: 200, json: { notes: [], used: 0, budget: 2000, max: 300 } });
  });

  it("lists the old array of strings as notes, newest first, without rewriting it", async () => {
    await setSetting("agent_notes", JSON.stringify(["Their name is Ada.", "They drink tea."]));
    const { json } = await call("GET", "/");
    expect(json.notes.map((n: any) => [n.text, n.inUse])).toEqual([["They drink tea.", true], ["Their name is Ada.", true]]);
    expect(json.used).toBe("Their name is Ada.".length + "They drink tea.".length + 6);
    expect(JSON.parse(getSetting("agent_notes")!)).toEqual(["Their name is Ada.", "They drink tea."]);
  });

  it("adds a note and answers with the list, refusing an empty one, a duplicate and a bad body", async () => {
    const r = await call("POST", "/", { text: "  They live in Oslo. " });
    expect(r.status).toBe(201);
    expect(r.json.notes[0]).toMatchObject({ text: "They live in Oslo.", inUse: true, at: expect.any(Number), id: expect.any(String) });
    expect(r.json.notes).toHaveLength(3);
    expect((await call("POST", "/", { text: "they live in OSLO." })).status).toBe(409);
    expect((await call("POST", "/", { text: " " })).status).toBe(400);
    expect((await call("POST", "/", { nope: 1 })).status).toBe(400);
    expect((await call("POST", "/", "not json")).status).toBe(400);
  });

  it("edits a note, refusing a duplicate, an empty text and an unknown id", async () => {
    const [newest, , oldest] = (await call("GET", "/")).json.notes;
    expect((await call("PUT", `/note/${newest.id}`, { text: "They live in Bergen." })).json.notes[0].text).toBe("They live in Bergen.");
    expect((await call("PUT", `/note/${newest.id}`, { text: "their name is ADA." })).status).toBe(409);
    expect((await call("PUT", `/note/${newest.id}`, { text: "" })).status).toBe(400);
    expect((await call("PUT", "/note/nope", { text: "x" })).status).toBe(404);
    expect(oldest.text).toBe("Their name is Ada.");
  });

  it("deletes one note, then all", async () => {
    const [newest] = (await call("GET", "/")).json.notes;
    expect((await call("DELETE", `/note/${newest.id}`)).json.notes).toHaveLength(2);
    expect((await call("DELETE", `/note/${newest.id}`)).status).toBe(404);
    expect((await call("DELETE", "/")).json).toEqual({ notes: [], used: 0, budget: 2000, max: 300 });
    expect(JSON.parse(getSetting("agent_notes")!)).toEqual([]);
  });

  it("marks what is past the prompt budget as not in use", async () => {
    for (let i = 0; i < 10; i++) await call("POST", "/", { text: `${i} ${"x".repeat(230)}` });
    const { json } = await call("GET", "/");
    expect(json.notes.map((n: any) => n.inUse)).toEqual([...Array(8).fill(true), false, false]);
    expect(json.used).toBeLessThanOrEqual(json.budget);
  });
});
