import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { denied, findFiles, plans, type Plan } from "./find.js";

const tmp = mkdtempSync(path.join(tmpdir(), "ol-find-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const NOW = Date.parse("2026-10-01T22:00:00Z");
const q = (text: string, extra: object = {}) => ({ text, home: "/home/u", now: NOW, ...extra });
/** A backend that is this Node script. */
const node = (name: string, script: string): Plan => ({ name, cmd: process.execPath, args: ["-e", script], sep: "\n" });

describe("the commands each OS runs", () => {
  it("macOS asks Spotlight for name or content under the home, recent ones by its own clock", () => {
    const [p, ...rest] = plans("darwin", q("tax return", { since: NOW - 7 * 86_400_000 }));
    expect(rest).toEqual([]);
    expect(p).toEqual({
      name: "spotlight", cmd: "mdfind", sep: "\0",
      args: ["-0", "-onlyin", "/home/u", '(kMDItemFSName == "*tax return*"cd || kMDItemTextContent == "tax return"cdw) && kMDItemFSContentChangeDate >= $time.now(-604800)'],
    });
  });

  it("Windows asks Windows Search through a fixed script, then Everything", () => {
    const [ws, es] = plans("win32", q("budget", { home: "C:\\Users\\u", since: Date.parse("2026-09-24T22:00:00Z") }));
    expect(ws!.cmd).toBe("powershell.exe");
    expect(ws!.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(ws!.env).toEqual({ OL_FIND_Q: "budget", OL_FIND_SCOPE: "C:\\Users\\u", OL_FIND_SINCE: "2026-09-24 22:00:00", OL_FIND_TOP: "500" });
    const script = Buffer.from(ws!.args[3]!, "base64").toString("utf16le");
    expect(script).toContain("SYSTEMINDEX");
    expect(script).toContain("$env:OL_FIND_Q");
    expect(es).toEqual({ name: "everything", cmd: "es.exe", sep: "\n", args: ["-n", "500", "-path", "C:\\Users\\u", "-search", "dm:>=2026-09-24 budget"] });
  });

  it("Linux tries fd under both its names, a live search, before plocate and locate", () => {
    const ps = plans("linux", q("notes", { since: NOW - 3600_000 }));
    expect(ps.map((p) => p.cmd)).toEqual(["fd", "fdfind", "plocate", "locate"]);
    expect(ps.map((p) => !!p.live)).toEqual([true, true, false, false]);
    expect(ps[2]!.args).toEqual(["-i", "-e", "-b", "-0", "--", "notes"]);
    expect(ps[0]!.args).toEqual(["-i", "-F", "-a", "-0", "--max-results", "500", "--changed-within", "3600s", "--", "notes", "/home/u"]);
  });

  it("the user's words stay one argument, and never become query syntax or an option", () => {
    const evil = `x" || kMDItemFSName == "*" ; rm -rf ~ $(whoami) *`;
    const mac = plans("darwin", q(evil))[0]!;
    expect(mac.args).toHaveLength(4);
    expect(mac.args[3]).toBe(String.raw`(kMDItemFSName == "*x\" || kMDItemFSName == \"\*\" ; rm -rf ~ $(whoami) \**"cd || kMDItemTextContent == "x\" || kMDItemFSName == \"\*\" ; rm -rf ~ $(whoami) \*"cdw)`);
    const win = plans("win32", q("a'); DROP --", { home: "C:\\u" }));
    // Nothing the user said is on the PowerShell command line: it goes in the environment.
    expect(win[0]!.args.join(" ")).not.toContain("DROP");
    expect(win[0]!.env!.OL_FIND_Q).toBe("a'); DROP --");
    const linux = plans("linux", q("-r --regex .*"));
    expect(linux[2]!.args.slice(-2)).toEqual(["--", "-r --regex .*"]);
    expect(linux[0]!.args.slice(-3, -1)).toEqual(["--", "-r --regex .*"]);
    expect(win[1]!.args.at(-2)).toBe("-search");
  });

  it("escapes the words for each part of the Windows Search SQL", () => {
    const script = Buffer.from(plans("win32", q("x", { home: "C:\\u" }))[0]!.args[3]!, "base64").toString("utf16le");
    expect(script).toContain(`-replace "'", "''"`);
    expect(script).toContain(`-replace '%', '[%]'`);
    expect(script).toContain(`-replace '"', '""'`);
    expect(script).not.toMatch(/Invoke-Expression|iex /i);
  });
});

describe("the deny list", () => {
  const home = "/Users/u";
  it("never shows credentials, keys, browser profiles or OpenLive's secrets", () => {
    for (const p of [
      "/Users/u/.ssh/id_ed25519", "/Users/u/.gnupg/pubring.kbx", "/Users/u/.openlive/secrets/providers.json",
      "/Users/u/code/app/.env", "/Users/u/code/app/.env.local", "/Users/u/Library/Keychains/login.keychain-db",
      "/Users/u/Library/Application Support/Google/Chrome/Default/Cookies", "/Users/u/.mozilla/firefox/x.default/logins.json",
      "/Users/u/.aws/credentials", "/Users/u/certs/server.pem", "/Users/u/work/id_rsa", "/Users/u/.netrc",
      "/Users/u/Library/Safari/History.db", "/Users/u/.config/gh/hosts.yml", "/Users/u/proj/secrets/api.txt",
      "/etc/passwd", "/Users/other/notes.txt", "/Users/u-evil/x.txt",
    ]) expect(denied(p, home, "darwin"), p).toBe(true);
    for (const p of ["/Users/u/Documents/taxes.pdf", "/Users/u/code/app/env.ts", "/Users/u/code/app/.envrc.md.txt", "/Users/u/keys.txt"]) {
      expect(denied(p, home, "darwin"), p).toBe(false);
    }
  });

  it("reads Windows paths with either slash and any case", () => {
    const home = "C:\\Users\\U";
    expect(denied("C:\\Users\\U\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data", home, "win32")).toBe(true);
    expect(denied("c:/users/u/.SSH/config", home, "win32")).toBe(true);
    expect(denied("C:\\Users\\U\\AppData\\Roaming\\Microsoft\\Credentials\\x", home, "win32")).toBe(true);
    expect(denied("C:\\Users\\U\\Documents\\plan.docx", home, "win32")).toBe(false);
  });
});

describe("finding", () => {
  const home = path.join(tmp, "home");
  mkdirSync(path.join(home, "docs", "deep"), { recursive: true });
  mkdirSync(path.join(home, ".ssh"));
  mkdirSync(path.join(home, "node_modules", "budget-lib"), { recursive: true });
  const put = (rel: string, ageDays: number) => {
    const p = path.join(home, rel);
    writeFileSync(p, "x");
    const t = (NOW - ageDays * 86_400_000) / 1000;
    utimesSync(p, t, t);
    return p;
  };
  const old = put("docs/budget-2024.xlsx", 400);
  const recent = put("docs/deep/budget-2026.xlsx", 2);
  const pdf = put("budget.pdf", 1);
  put(".ssh/budget", 0);
  put("docs/.env", 0);

  it("walks the home where no index answers, skipping hidden, cache and denied folders, newest first", async () => {
    const r = await findFiles({ query: "BUDGET" }, { home, plans: [], now: NOW });
    expect(r.backend).toBe("walk");
    expect(r.items.map((h) => h.path)).toEqual([pdf, recent, old]);
    expect(r.items[0]).toMatchObject({ kind: "pdf", size: 1 });
    expect(r.partial).toBe(false);
  });

  it("filters by kind and by how recently it changed, and keeps to the limit", async () => {
    expect((await findFiles({ query: "budget", kind: "spreadsheet" }, { home, plans: [], now: NOW })).items.map((h) => h.path)).toEqual([recent, old]);
    expect((await findFiles({ query: "budget", modified_within: "P7D" }, { home, plans: [], now: NOW })).items.map((h) => h.path)).toEqual([pdf, recent]);
    expect((await findFiles({ query: "budget", limit: 1 }, { home, plans: [], now: NOW })).items).toHaveLength(1);
    expect((await findFiles({ query: "docs", kind: "folder" }, { home, plans: [], now: NOW })).items.map((h) => h.kind)).toEqual(["folder"]);
    await expect(findFiles({ query: "budget", modified_within: "lately" }, { home, plans: [] })).rejects.toThrow(/not a duration/);
    await expect(findFiles({ query: "  " }, { home, plans: [] })).rejects.toThrow(/what to look for/);
  });

  it("falls back past a missing command and one that fails, and stops at the first that answers", async () => {
    const r = await findFiles({ query: "budget" }, {
      home, now: NOW,
      plans: [
        { name: "missing", cmd: path.join(tmp, "no-such-command"), args: [], sep: "\n" },
        node("broken", "console.error('database not found'); process.exit(1)"),
        node("index", `console.log(${JSON.stringify([pdf, path.join(home, ".ssh/budget"), "/etc/passwd", path.join(home, "docs/.env")].join("\n"))})`),
        node("never", `console.log(${JSON.stringify(old)})`),
      ],
    });
    expect(r.backend).toBe("index");
    expect(r.items.map((h) => h.path)).toEqual([pdf]);
  });

  it("an index that answers with nothing, as Spotlight switched off does, falls back to the walk", async () => {
    for (const empty of [node("spotlight", "process.exit(0)"), node("locate", "process.exit(1)")]) {
      const r = await findFiles({ query: "budget" }, { home, now: NOW, plans: [empty, node("stale", "process.exit(0)")] });
      expect(r.backend).toBe("walk");
      expect(r.items.map((h) => h.path)).toEqual([pdf, recent, old]);
    }
  });

  it("a live search's empty answer is final", async () => {
    const r = await findFiles({ query: "budget" }, { home, now: NOW, plans: [{ ...node("fd", "process.exit(0)"), live: true }, node("never", `console.log(${JSON.stringify(old)})`)] });
    expect(r).toEqual({ items: [], partial: false, backend: "fd" });
  });

  it("stops at the time limit with what it has, and says so", async () => {
    const started = Date.now();
    const r = await findFiles({ query: "budget" }, {
      home, now: NOW, timeMs: 300,
      plans: [node("slow", `console.log(${JSON.stringify(recent)}); setTimeout(() => {}, 10000)`)],
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r).toMatchObject({ partial: true, backend: "slow" });
    expect(r.items.map((h) => h.path)).toEqual([recent]);
  });

  it("stops reading once it has enough candidates", async () => {
    const r = await findFiles({ query: "budget", limit: 100 }, {
      home, now: NOW,
      plans: [node("flood", `const p = ${JSON.stringify(recent)}; for (let i = 0; i < 2000; i++) console.log(p + "-" + i); console.log(p); setTimeout(() => {}, 10000)`)],
    });
    // 500 paths that do not exist were taken, so the real one never was, and it did not wait out the flood.
    expect(r).toMatchObject({ items: [], partial: false });
  });
});
