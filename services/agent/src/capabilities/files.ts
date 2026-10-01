import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { realpathSync, existsSync } from "node:fs";
import path from "node:path";
import type { Tool, ToolCtx, ToolResult } from "./types.js";

// File tools, scoped to the conversation's workspace folder. Reads are free;
// writes and edits say what they are about to do, so a policy that asks first
// can. Every path is confined to the workspace root: a request that escapes it
// lexically (../, an absolute path elsewhere) OR through a symlink inside the
// workspace is refused before any fs call.

const MAX_READ = 100_000;   // chars returned from read_file (rest truncated)
const MAX_FILE = 2_000_000; // refuse to read files larger than this (likely binary)

const t = (output: string): ToolResult<null> => ({ content: [{ type: "text", text: output }], details: null });
/** Thrown, so dispatch hands it back as the error result the model reads. */
const fail = (why: string): never => { throw new Error(why); };

const safeReal = (p: string): string | null => { try { return realpathSync.native(p); } catch { return null; } };

/** Resolve `rel` under `root`, or null if it escapes the root. Exported for the
 *  self-check — this is the security fence, so it gets a runnable test.
 *  Two fences: a lexical prefix check, then a realpath check on the deepest
 *  existing ancestor (so a symlink inside the workspace pointing out — or a
 *  write into a symlinked dir — resolves out and is refused). */
export function confine(root: string, rel: string): string | null {
  if (!root) return null;
  const base = safeReal(path.resolve(root)) ?? path.resolve(root);
  const abs = path.resolve(base, rel || ".");
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  // Realpath fence: walk down from base toward abs to the deepest EXISTING
  // component (a write target may not exist yet), resolve symlinks, and require
  // it still inside base. Never probes above base.
  let probe = abs;
  while (probe !== base && !existsSync(probe)) probe = path.dirname(probe);
  if (!existsSync(probe)) return abs; // workspace itself doesn't exist yet — lexical fence only
  const real = safeReal(probe);
  if (real === null) return null;
  if (real !== base && !real.startsWith(base + path.sep)) return null;
  return abs;
}

const root = (ctx: ToolCtx) => ctx.workspace!().trim() || fail("No workspace folder is set for this call. Ask the user to pick a project folder from the folder menu in the top bar, then try again.");
const within = (ctx: ToolCtx, rel: string) => confine(root(ctx), rel) ?? fail("That path is outside the workspace folder — not allowed.");
const relPath = (args: { path?: unknown }) => String(args?.path ?? "").trim() || fail("No file path given.");
const hasWorkspace = (s: { workspace?: () => string }) => !!s.workspace;

/** The file's text, when `find` appears in it exactly once. */
async function matchOnce(abs: string, find: string): Promise<string> {
  if (!find) return fail("No 'find' text given.");
  let body: string;
  try { body = await readFile(abs, "utf8"); } catch (e: any) { return fail(`Couldn't read that file: ${String(e?.message ?? e)}`); }
  const hits = body.split(find).length - 1;
  if (hits === 0) return fail("Couldn't find that exact text. Read the file first to get the snippet right.");
  if (hits > 1) return fail(`That snippet appears ${hits} times. Make it more specific so it matches exactly once.`);
  return body;
}

const listDir: Tool<{ path?: string }, null> = {
  name: "list_dir",
  group: "files",
  description: "List files and folders inside the user's workspace project folder. Pass a relative subpath to look deeper, or omit for the workspace root. Read-only, no approval needed.",
  parameters: { type: "object", properties: { path: { type: "string", description: "Relative subpath inside the workspace (optional; default is the root)" } }, additionalProperties: false },
  readOnly: true,
  available: hasWorkspace,
  promptGuidelines: [
    "When a workspace folder is set, you can look at and change files IN it: `list_dir` and `read_file` to explore and read (no approval needed), `write_file` and `edit_file` to create or change files. The user is ASKED to approve every write or edit before it happens — so just go ahead and make the change; they'll confirm.",
    "You can ONLY touch files inside that folder. If no folder is set and the user wants file work, tell them to pick a project folder first — the folder menu in the top bar during a call, or the folder field in the pre-call setup.",
    "Read before you edit so your snippet matches exactly. Keep it spoken: say what you did in a sentence — \"done, added that function\" — never read code, file paths, or file contents aloud (name things plainly instead) unless they explicitly ask.",
  ],
  async execute(args, ctx) {
    const abs = within(ctx, String(args?.path ?? ""));
    try {
      const entries = await readdir(abs, { withFileTypes: true });
      if (!entries.length) return t("(empty folder)");
      const shown = entries.slice(0, 200).map((e) => `${e.isDirectory() ? "[dir] " : "      "}${e.name}`).join("\n");
      return t(shown + (entries.length > 200 ? `\n…and ${entries.length - 200} more` : ""));
    } catch (e: any) { return fail(`Couldn't list that folder: ${String(e?.message ?? e)}`); }
  },
};

const readFileTool: Tool<{ path: string }, null> = {
  name: "read_file",
  group: "files",
  description: "Read a text file inside the user's workspace folder and return its contents. Read-only, no approval needed.",
  parameters: { type: "object", properties: { path: { type: "string", description: "Relative path to the file inside the workspace" } }, required: ["path"], additionalProperties: false },
  readOnly: true,
  available: hasWorkspace,
  async execute(args, ctx) {
    const abs = within(ctx, relPath(args));
    const s = await stat(abs).catch((e) => fail(`Couldn't read that file: ${String(e?.message ?? e)}`));
    if (s.isDirectory()) return fail("That's a folder, not a file — use list_dir.");
    if (s.size > MAX_FILE) return fail(`That file is too large to read (${Math.round(s.size / 1024)} KB).`);
    const body = await readFile(abs, "utf8").catch((e) => fail(`Couldn't read that file: ${String(e?.message ?? e)}`));
    return t(body.length > MAX_READ ? `${body.slice(0, MAX_READ)}\n…(truncated — ${body.length} chars total)` : (body || "(empty file)"));
  },
};

const writeFileTool: Tool<{ path: string; content: string }, null> = {
  name: "write_file",
  group: "files",
  description: "Create a new file or overwrite an existing one inside the user's workspace folder. The user is asked to approve before anything is written.",
  parameters: { type: "object", properties: { path: { type: "string", description: "Relative path inside the workspace" }, content: { type: "string", description: "The full file contents to write" } }, required: ["path", "content"], additionalProperties: false },
  available: hasWorkspace,
  confirm: (a) => `create or overwrite ${String(a.path ?? "").trim()} (${String(a.content ?? "").length} chars) in your workspace`,
  precheck: (args, ctx) => { within(ctx, relPath(args)); },
  async execute(args, ctx) {
    const rel = relPath(args);
    const abs = within(ctx, rel);
    const content = String(args?.content ?? "");
    try {
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
    } catch (e: any) { return fail(`Couldn't write that file: ${String(e?.message ?? e)}`); }
    return t(`Wrote ${rel} (${content.length} chars).`);
  },
};

const editFileTool: Tool<{ path: string; find: string; replace: string }, null> = {
  name: "edit_file",
  group: "files",
  description: "Make a targeted change to a text file in the user's workspace by replacing an exact snippet with new text (the snippet must appear exactly once). The user approves before it's applied. For a full rewrite use write_file instead.",
  parameters: { type: "object", properties: { path: { type: "string", description: "Relative path inside the workspace" }, find: { type: "string", description: "The exact text to replace — must appear exactly once" }, replace: { type: "string", description: "The new text" } }, required: ["path", "find", "replace"], additionalProperties: false },
  available: hasWorkspace,
  confirm: (a) => `edit ${String(a.path ?? "").trim()} in your workspace`,
  precheck: async (args, ctx) => { await matchOnce(within(ctx, relPath(args)), String(args?.find ?? "")); },
  async execute(args, ctx) {
    const rel = relPath(args);
    const abs = within(ctx, rel);
    const find = String(args?.find ?? ""); const replace = String(args?.replace ?? "");
    // Again, since the file may have changed while the person was deciding.
    const body = await matchOnce(abs, find);
    try { await writeFile(abs, body.replace(find, replace), "utf8"); }
    catch (e: any) { return fail(`Couldn't write that file: ${String(e?.message ?? e)}`); }
    return t(`Edited ${rel}.`);
  },
};

export const FILE_TOOLS: Tool[] = [listDir, readFileTool, writeFileTool, editFileTool];
