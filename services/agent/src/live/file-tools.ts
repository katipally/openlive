import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { realpathSync, existsSync } from "node:fs";
import path from "node:path";
import type { OpenLiveTool, ToolResult } from "../tools.js";

// File tools for the BUILT-IN OpenLive assistant, scoped to the conversation's
// workspace folder. Reads are free; writes/edits go through the same ask-before-
// acting permission prompt the coding agents use. Every path is confined to the
// workspace root — a request that escapes it lexically (../, an absolute path
// elsewhere) OR through a symlink inside the workspace is refused before any
// fs call.

const MAX_READ = 100_000;   // chars returned from read_file (rest truncated)
const MAX_FILE = 2_000_000; // refuse to read files larger than this (likely binary)

const t = (output: string, isError = false): ToolResult => ({ output, isError });

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

export interface FileToolsCtx {
  cwd: () => string; // the live workspace root (read at execute time — it can change per call)
  ask: (question: string, options: { id: string; label: string }[]) => Promise<string>;
}

export function buildFileTools(ctx: FileToolsCtx): OpenLiveTool[] {
  const root = () => ctx.cwd().trim();
  const noWs = () => t("No workspace folder is set for this call. Ask the user to pick a project folder on the right, then try again.", true);
  const outside = () => t("That path is outside the workspace folder — not allowed.", true);
  const confirmWrite = async (what: string) => {
    const choice = await ctx.ask(`OpenLive wants to ${what} in your workspace. Allow it?`, [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }]);
    return choice === "allow";
  };

  const listDir: OpenLiveTool = {
    name: "list_dir",
    description: "List files and folders inside the user's workspace project folder. Pass a relative subpath to look deeper, or omit for the workspace root. Read-only, no approval needed.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Relative subpath inside the workspace (optional; default is the root)" } }, additionalProperties: false },
    execute: async (args) => {
      const r = root(); if (!r) return noWs();
      const abs = confine(r, String(args?.path ?? "")); if (!abs) return outside();
      try {
        const entries = await readdir(abs, { withFileTypes: true });
        if (!entries.length) return t("(empty folder)");
        const shown = entries.slice(0, 200).map((e) => `${e.isDirectory() ? "[dir] " : "      "}${e.name}`).join("\n");
        return t(shown + (entries.length > 200 ? `\n…and ${entries.length - 200} more` : ""));
      } catch (e: any) { return t(`Couldn't list that folder: ${String(e?.message ?? e)}`, true); }
    },
  };

  const readFileTool: OpenLiveTool = {
    name: "read_file",
    description: "Read a text file inside the user's workspace folder and return its contents. Read-only, no approval needed.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Relative path to the file inside the workspace" } }, required: ["path"], additionalProperties: false },
    execute: async (args) => {
      const r = root(); if (!r) return noWs();
      const rel = String(args?.path ?? "").trim(); if (!rel) return t("No file path given.", true);
      const abs = confine(r, rel); if (!abs) return outside();
      try {
        const s = await stat(abs);
        if (s.isDirectory()) return t("That's a folder, not a file — use list_dir.", true);
        if (s.size > MAX_FILE) return t(`That file is too large to read (${Math.round(s.size / 1024)} KB).`, true);
        const body = await readFile(abs, "utf8");
        return t(body.length > MAX_READ ? `${body.slice(0, MAX_READ)}\n…(truncated — ${body.length} chars total)` : (body || "(empty file)"));
      } catch (e: any) { return t(`Couldn't read that file: ${String(e?.message ?? e)}`, true); }
    },
  };

  const writeFileTool: OpenLiveTool = {
    name: "write_file",
    description: "Create a new file or overwrite an existing one inside the user's workspace folder. The user is asked to approve before anything is written.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Relative path inside the workspace" }, content: { type: "string", description: "The full file contents to write" } }, required: ["path", "content"], additionalProperties: false },
    execute: async (args) => {
      const r = root(); if (!r) return noWs();
      const rel = String(args?.path ?? "").trim(); if (!rel) return t("No file path given.", true);
      const abs = confine(r, rel); if (!abs) return outside();
      const content = String(args?.content ?? "");
      if (!(await confirmWrite(`create or overwrite ${rel} (${content.length} chars)`))) return t("Write cancelled — the user didn't approve it.");
      try {
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, content, "utf8");
        return t(`Wrote ${rel} (${content.length} chars).`);
      } catch (e: any) { return t(`Couldn't write that file: ${String(e?.message ?? e)}`, true); }
    },
  };

  const editFileTool: OpenLiveTool = {
    name: "edit_file",
    description: "Make a targeted change to a text file in the user's workspace by replacing an exact snippet with new text (the snippet must appear exactly once). The user approves before it's applied. For a full rewrite use write_file instead.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Relative path inside the workspace" }, find: { type: "string", description: "The exact text to replace — must appear exactly once" }, replace: { type: "string", description: "The new text" } }, required: ["path", "find", "replace"], additionalProperties: false },
    execute: async (args) => {
      const r = root(); if (!r) return noWs();
      const rel = String(args?.path ?? "").trim(); if (!rel) return t("No file path given.", true);
      const abs = confine(r, rel); if (!abs) return outside();
      const find = String(args?.find ?? ""); const replace = String(args?.replace ?? "");
      if (!find) return t("No 'find' text given.", true);
      let body: string;
      try { body = await readFile(abs, "utf8"); } catch (e: any) { return t(`Couldn't read that file: ${String(e?.message ?? e)}`, true); }
      const hits = body.split(find).length - 1;
      if (hits === 0) return t("Couldn't find that exact text — read the file first to get the snippet right.", true);
      if (hits > 1) return t(`That snippet appears ${hits} times — make it more specific so it matches exactly once.`, true);
      if (!(await confirmWrite(`edit ${rel}`))) return t("Edit cancelled — the user didn't approve it.");
      try { await writeFile(abs, body.replace(find, replace), "utf8"); return t(`Edited ${rel}.`); }
      catch (e: any) { return t(`Couldn't write that file: ${String(e?.message ?? e)}`, true); }
    },
  };

  return [listDir, readFileTool, writeFileTool, editFileTool];
}
