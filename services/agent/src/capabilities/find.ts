import { spawn } from "node:child_process";
import { opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseDuration } from "../reminders/time.js";
import type { Tool, ToolResult } from "./types.js";

// find_files: the user's home folder through the OS's own search index, with a
// bounded walk where there is none or it finds nothing. It only finds: reading
// stays with read_file. Every path passes the deny list before anyone sees
// it, whichever backend found it. Commands spawn without a shell, and the user's
// words reach each one as a single argument or an environment variable, escaped
// for that backend's own query language.

const LIMIT = 20;
const LIMIT_MAX = 100;
const TIME_MS = 3000;
/** Paths kept for stat and sorting before the newest `limit` are picked. */
const CANDIDATES = 500;
const QUERY_MAX = 200;
const WALK_DEPTH = 8;
const WALK_ENTRIES = 200_000;

const KINDS = {
  document: "doc docx odt rtf txt md pages tex epub",
  spreadsheet: "xls xlsx ods csv tsv numbers",
  presentation: "ppt pptx odp",
  pdf: "pdf",
  image: "png jpg jpeg gif webp heic heif bmp tif tiff svg",
  audio: "mp3 m4a wav aac flac ogg opus aiff",
  video: "mp4 mov mkv avi webm m4v",
  archive: "zip tar gz tgz bz2 xz 7z rar dmg iso",
  code: "js mjs cjs ts tsx jsx py rb go rs java kt swift c h cpp cs php sh json yaml yml toml html css sql",
} as const;
type Kind = keyof typeof KINDS | "folder" | "file";
const KIND_OF = new Map(Object.entries(KINDS).flatMap(([k, exts]) => exts.split(" ").map((e) => [e, k as Kind] as const)));
const extKind = (name: string): Kind => KIND_OF.get(path.extname(name).slice(1).toLowerCase()) ?? "file";

// ── the deny list ───────────────────────────────────────────────────────────
// Lower-cased and with forward slashes, so one list serves every OS. Folding
// case on Linux denies a little more than it must, never less.

/** Folders under the home: browser profiles, cloud and tool credentials. */
const DENY_UNDER_HOME = [
  ".docker", ".azure", ".gcloud", ".config/gcloud", ".config/gh", ".local/share/keyrings",
  ".mozilla", ".thunderbird", ".config/google-chrome", ".config/chromium", ".config/bravesoftware",
  ".config/microsoft-edge", ".config/vivaldi", ".config/opera",
  "library/safari", "library/cookies", "library/application support/google/chrome",
  "library/application support/chromium", "library/application support/firefox",
  "library/application support/bravesoftware", "library/application support/microsoft edge",
  "library/application support/arc", "library/application support/vivaldi",
  "library/application support/com.operasoftware.opera",
  "appdata/local/google/chrome/user data", "appdata/local/chromium/user data",
  "appdata/local/microsoft/edge/user data", "appdata/local/bravesoftware", "appdata/local/vivaldi",
  "appdata/roaming/mozilla", "appdata/roaming/opera software", "appdata/roaming/microsoft/credentials",
  "appdata/local/microsoft/credentials", "appdata/roaming/microsoft/protect", "appdata/roaming/microsoft/crypto",
  "appdata/roaming/microsoft/systemcertificates",
];
/** A folder with one of these names, at any depth: ~/.ssh, ~/.openlive/secrets, Library/Keychains. */
const DENY_ANYWHERE = new Set([".ssh", ".gnupg", ".aws", ".kube", ".password-store", "keychains", "secrets"]);
const DENY_NAME = /^(?:\.env(?:\..*)?|\.netrc|\.pgpass|\.npmrc|\.pypirc|\.git-credentials|\.htpasswd|\.enc-key|credentials(?:\.json)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|jks|keystore|kdbx|keychain|keychain-db|ppk|gpg))$/;

const fold = (p: string, platform: NodeJS.Platform) => (platform === "win32" ? p.replace(/\\/g, "/") : p).replace(/\/+$/, "").toLowerCase();

/** Never shown: outside the home, or credential-like. O(segments + list) per path. */
export function denied(p: string, home: string, platform: NodeJS.Platform = process.platform): boolean {
  const h = fold(home, platform), f = fold(p, platform);
  if (!f.startsWith(`${h}/`)) return true;
  const rel = f.slice(h.length + 1);
  if (DENY_UNDER_HOME.some((d) => rel === d || rel.startsWith(`${d}/`))) return true;
  const segs = rel.split("/");
  return segs.some((s) => DENY_ANYWHERE.has(s)) || DENY_NAME.test(segs.at(-1)!);
}

// ── backends ────────────────────────────────────────────────────────────────

export interface Plan {
  name: string; cmd: string; args: string[]; env?: Record<string, string>; sep: "\0" | "\n";
  /** It walks the disk now rather than reading an index, so its empty answer is final. */
  live?: true;
}
export interface FindQuery { text: string; home: string; /** Epoch ms, or none. */ since?: number; now: number }

/** Spotlight's query language: a backslash keeps a quote or wildcard literal. */
const spotlight = (s: string) => s.replace(/[\\"*?]/g, "\\$&");

// Windows Search through its OLE DB provider. The script never changes; the
// user's words arrive in OL_FIND_Q and are escaped here for a SQL literal, a
// LIKE pattern and a CONTAINS phrase, so nothing they say becomes SQL.
const WINDOWS_SEARCH = String.raw`$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$q = $env:OL_FIND_Q
$like = ($q -replace '\[', '[[]' -replace '%', '[%]' -replace '_', '[_]') -replace "'", "''"
$phrase = ($q -replace '"', '""') -replace "'", "''"
$scope = ($env:OL_FIND_SCOPE -replace '\\', '/') -replace "'", "''"
$sql = "SELECT TOP $([int]$env:OL_FIND_TOP) System.ItemPathDisplay FROM SYSTEMINDEX WHERE SCOPE='file:$scope' AND (System.FileName LIKE '%$like%' OR CONTAINS('""$phrase""'))"
if ($env:OL_FIND_SINCE -match '^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$') { $sql += " AND System.DateModified >= '$($env:OL_FIND_SINCE)'" }
$c = New-Object -ComObject ADODB.Connection
$c.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
$r = $c.Execute($sql)
while (-not $r.EOF) { [Console]::Out.Write([string]$r.Fields.Item('System.ItemPathDisplay').Value + [char]0); $r.MoveNext() }
$c.Close()`;
const WINDOWS_SEARCH_B64 = Buffer.from(WINDOWS_SEARCH, "utf16le").toString("base64");

const secondsSince = (q: FindQuery) => Math.max(1, Math.ceil((q.now - q.since!) / 1000));
/** "2026-09-24 13:05:00" in UTC, as Windows Search compares dates. */
const sqlDate = (t: number) => new Date(t).toISOString().slice(0, 19).replace("T", " ");

/** The index-backed commands to try in order, before the bounded walk. */
export function plans(platform: NodeJS.Platform, q: FindQuery): Plan[] {
  if (platform === "darwin") {
    const t = spotlight(q.text);
    const recent = q.since ? ` && kMDItemFSContentChangeDate >= $time.now(-${secondsSince(q)})` : "";
    return [{ name: "spotlight", cmd: "mdfind", args: ["-0", "-onlyin", q.home, `(kMDItemFSName == "*${t}*"cd || kMDItemTextContent == "${t}"cdw)${recent}`], sep: "\0" }];
  }
  if (platform === "win32") {
    const since = q.since ? new Date(q.since).toISOString().slice(0, 10) : "";
    return [
      {
        name: "windows-search", cmd: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", WINDOWS_SEARCH_B64],
        env: { OL_FIND_Q: q.text, OL_FIND_SCOPE: q.home, OL_FIND_SINCE: q.since ? sqlDate(q.since) : "", OL_FIND_TOP: String(CANDIDATES) }, sep: "\0",
      },
      // -search takes the next argument as search text, so words starting with "-" are not read as options.
      { name: "everything", cmd: "es.exe", args: ["-n", String(CANDIDATES), "-path", q.home, "-search", since ? `dm:>=${since} ${q.text}` : q.text], sep: "\n" },
    ];
  }
  const locate = (cmd: string): Plan => ({ name: cmd, cmd, args: ["-i", "-e", "-b", "-0", "--", q.text], sep: "\0" });
  const fd = (cmd: string): Plan => ({
    name: cmd, cmd, sep: "\0", live: true,
    args: ["-i", "-F", "-a", "-0", "--max-results", String(CANDIDATES), ...(q.since ? ["--changed-within", `${secondsSince(q)}s`] : []), "--", q.text, q.home],
  });
  // fd first: locate's database is rebuilt about daily, so it misses what changed since.
  return [fd("fd"), fd("fdfind"), locate("plocate"), locate("locate")];
}

type Outcome = "done" | "failed" | "timeout";

/**
 * Runs one backend, handing each path to `take` until it says it has enough.
 * Failed is a command that is missing, or that exited badly and said why on
 * stderr: locate exits 1 for no match, silently, and that is an answer.
 */
export function runPlan(plan: Plan, deadline: number, take: (p: string) => boolean): Promise<Outcome> {
  return new Promise((resolve) => {
    let out: Outcome | null = null, full = false, timedOut = false, buf = "", err = "";
    const child = spawn(plan.cmd, plan.args, { env: plan.env ? { ...process.env, ...plan.env } : process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const finish = (o: Outcome) => { if (out) return; out = o; clearTimeout(timer); resolve(o); };
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, Math.max(0, deadline - Date.now()));
    const offer = (p: string) => { const clean = p.replace(/\r$/, ""); if (clean && take(clean)) { full = true; child.kill(); } };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (full) return;
      const parts = (buf + chunk).split(plan.sep);
      buf = parts.pop()!;
      for (const p of parts) { offer(p); if (full) return; }
    });
    child.stderr.on("data", (c: Buffer) => { if (err.length < 2000) err += c.toString(); });
    child.on("error", () => finish("failed"));
    child.on("close", (code) => {
      if (!full && !timedOut && buf) offer(buf);
      finish(full ? "done" : timedOut ? "timeout" : code === 0 || !err.trim() ? "done" : "failed");
    });
  });
}

const SKIP = new Set(["node_modules", "__pycache__", "Library", "AppData", "cache", "Caches"]);

/**
 * Breadth first from the home, names only, skipping hidden folders, caches and
 * denied ones. O(entries visited), bounded by depth, entry count and the deadline.
 */
export async function walk(q: FindQuery, deadline: number, take: (p: string) => boolean, platform: NodeJS.Platform = process.platform): Promise<Outcome> {
  const needle = q.text.toLowerCase();
  let level = [q.home], seen = 0;
  for (let depth = 0; depth < WALK_DEPTH && level.length; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      let d;
      try { d = await opendir(dir); } catch { continue; }
      for await (const e of d) {
        if (Date.now() > deadline || ++seen > WALK_ENTRIES) return "timeout";
        const full = path.join(dir, e.name);
        if (e.name.toLowerCase().includes(needle) && take(full)) return "done";
        if (e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name) && !denied(full, q.home, platform)) next.push(full);
      }
    }
    level = next;
  }
  return "done";
}

// ── the tool ────────────────────────────────────────────────────────────────

export interface Hit { path: string; kind: Kind; size: number; modified: string }
export interface Found { items: Hit[]; partial: boolean; backend: string }

export interface FindArgs { query: string; kind?: Kind | "any"; modified_within?: string; limit?: number }

/** Index first, then the walk when none answered with anything; the newest `limit` of what passed the deny list and the filters. */
export async function findFiles(args: FindArgs, o: { platform?: NodeJS.Platform; home?: string; plans?: Plan[]; timeMs?: number; now?: number } = {}): Promise<Found> {
  const platform = o.platform ?? process.platform, home = o.home ?? homedir(), now = o.now ?? Date.now();
  const text = String(args.query ?? "").replace(/\s+/g, " ").trim().slice(0, QUERY_MAX);
  if (!text) throw new Error("Say what to look for.");
  const within = args.modified_within ? parseDuration(args.modified_within) : null;
  if (args.modified_within && !within) throw new Error(`"${args.modified_within}" is not a duration. Use ISO 8601 like P7D or PT2H.`);
  const want = args.kind && args.kind !== "any" ? args.kind : null;
  const limit = Math.min(LIMIT_MAX, Math.max(1, Math.floor(Number(args.limit) || LIMIT)));
  const q: FindQuery = { text, home, now, ...(within && { since: now - within }) };
  const deadline = Date.now() + (o.timeMs ?? TIME_MS);

  const kept = new Set<string>();
  const take = (p: string) => {
    if (!kept.has(p) && !denied(p, home, platform) && (!want || want === "folder" || want === "file" || extKind(p) === want)) kept.add(p);
    return kept.size >= CANDIDATES;
  };
  let backend = "walk", outcome: Outcome | null = null;
  for (const plan of o.plans ?? plans(platform, q)) {
    const got = await runPlan(plan, deadline, take);
    // An index can answer with nothing because it is off or stale (Spotlight
    // disabled, an old locate database), so only a live search's empty answer is final.
    if (got === "timeout" || (got === "done" && (kept.size || plan.live))) { outcome = got; backend = plan.name; break; }
  }
  outcome ??= await walk(q, deadline, take, platform);

  const stats = await Promise.all([...kept].map(async (p) => {
    try { return [{ p, s: await stat(p) }]; } catch { return []; }
  }));
  const items = stats.flat()
    .filter(({ p, s }) => (!q.since || s.mtimeMs >= q.since) && (want !== "folder" || s.isDirectory()) && (want !== "file" || !s.isDirectory()))
    .sort((a, b) => b.s.mtimeMs - a.s.mtimeMs)
    .slice(0, limit)
    .map(({ p, s }): Hit => ({ path: p, kind: s.isDirectory() ? "folder" : extKind(p), size: s.isDirectory() ? 0 : s.size, modified: new Date(s.mtimeMs).toISOString() }));
  return { items, partial: outcome === "timeout", backend };
}

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

export const findFilesTool: Tool<FindArgs, Found> = {
  name: "find_files",
  group: "find",
  readOnly: true,
  description: "Find files and folders anywhere in the user's home folder by name or by words inside them, through the computer's own search index. Returns each path with its kind, size and when it was modified, newest first. It does not open files, and never lists keys, passwords, browser data or .env files.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Words from the file's name or contents, like \"tax return\" or \"budget.xlsx\"." },
      kind: { type: "string", enum: ["any", "folder", "file", ...Object.keys(KINDS)], description: "Only this kind. Defaults to any." },
      modified_within: { type: "string", description: "Only ones changed this recently: ISO 8601 like P7D or PT2H." },
      limit: { type: "number", description: `How many to return, newest first. Defaults to ${LIMIT}, at most ${LIMIT_MAX}.` },
    },
    required: ["query"],
    additionalProperties: false,
  },
  promptGuidelines: [
    "`find_files` only finds. In a call, `read_file` reads inside the workspace folder alone, so to read something found elsewhere, ask the user to pick its folder as the workspace or to open the file.",
  ],
  async execute(args): Promise<ToolResult<Found>> {
    const found = await findFiles(args);
    const lines = found.items.map((h) => `- ${h.path} (${h.kind}${h.kind === "folder" ? "" : `, ${size(h.size)}`}, modified ${h.modified})`);
    const head = found.items.length ? `Found ${found.items.length}, newest first:` : `Nothing in the home folder matches "${args.query}".`;
    const tail = found.partial ? `\nThe search stopped at its ${TIME_MS / 1000} second limit, so there may be more.` : "";
    return { content: [{ type: "text", text: [head, ...lines].join("\n") + tail }], details: found };
  },
};
