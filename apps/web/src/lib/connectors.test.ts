import { describe, expect, it } from "vitest";
import type { ConnectorImportSource, ConnectorStatus, ConnectorWire } from "@openlive/shared";
import { STATUS, bulkTools, draftOf, editPatch, initialPicks, monogram, pickKey, pickedItems, secretPatch, signInPollMs, signInsPollMs, transportLine } from "./connectors";

const base = { enabled: true, source: "manual", createdAt: "", spawnConsent: true, signedIn: false, status: "connected", tools: [] } as const;
const stdio: ConnectorWire = {
  ...base, id: "s", name: "Files", slug: "files",
  transport: { type: "stdio", command: "npx", args: ["-y", "server"], env: { LOG: "1" }, secretEnv: ["TOKEN"] },
};
const http: ConnectorWire = { ...base, id: "h", name: "Linear", slug: "linear", transport: { type: "http", url: "https://mcp.linear.app/mcp", headers: ["Authorization"] } };

describe("status", () => {
  it("has a label and a dot for every status the agent sends", () => {
    const all: ConnectorStatus[] = ["disabled", "needs_consent", "disconnected", "connecting", "connected", "needs_auth", "error"];
    for (const s of all) expect(STATUS[s].text).toBeTruthy();
    expect(Object.keys(STATUS).sort()).toEqual([...all].sort());
    expect(STATUS.error.dot).toBe("danger");
    expect(STATUS.connected.dot).toBe("success");
  });

  it("reads a transport as one line, quoting an argument with spaces", () => {
    expect(transportLine(http.transport)).toBe("https://mcp.linear.app/mcp");
    expect(transportLine({ ...stdio.transport, args: ["--dir", "My Files"] } as ConnectorWire["transport"])).toBe('npx --dir "My Files"');
  });

  it("polls a sign-in fast, then slower, then stops after five minutes", () => {
    expect(signInPollMs(0)).toBe(2000);
    expect(signInPollMs(60_000)).toBe(5000);
    expect(signInPollMs(4 * 60_000)).toBe(10_000);
    expect(signInPollMs(5 * 60_000)).toBe(false);
  });

  it("polls several sign-ins at the pace of the newest, until all give up", () => {
    const now = 10 * 60_000;
    expect(signInsPollMs([], now)).toBe(false);
    expect(signInsPollMs([now - 60_000, now - 1000], now)).toBe(2000);
    expect(signInsPollMs([now - 6 * 60_000, now - 60_000], now)).toBe(5000);
    expect(signInsPollMs([now - 6 * 60_000], now)).toBe(false);
  });
});

describe("secrets are write-only", () => {
  it("keeps a saved secret left blank, replaces a typed one, removes a dropped one, and asks for a new one's value", () => {
    const r = secretPatch(["A", "B", "C"], [
      { key: "A", value: "", secret: true },
      { key: "B", value: "new", secret: true },
      { key: "D", value: "", secret: true },
    ]);
    expect(r.patch).toEqual({ B: "new", C: null });
    expect(r.missing).toEqual(["D"]);
  });

  it("never puts a saved secret's value in the draft", () => {
    const d = draftOf(stdio);
    expect(d.rows).toEqual([{ key: "LOG", value: "1", secret: false }, { key: "TOKEN", value: "", secret: true }]);
    expect(draftOf(http).rows).toEqual([{ key: "Authorization", value: "", secret: true }]);
  });

  it("sends nothing for an untouched edit", () => {
    expect(editPatch(stdio, draftOf(stdio))).toEqual({ patch: {} });
    expect(editPatch(http, draftOf(http))).toEqual({ patch: {} });
  });

  it("moves a plain variable into the secrets when it is marked secret", () => {
    const d = draftOf(stdio);
    d.rows[0]!.secret = true;
    expect(editPatch(stdio, d)).toEqual({ patch: { env: {}, secretEnv: { LOG: "1" } } });
  });

  it("asks for a value before a secret becomes plain, then removes the secret", () => {
    const d = draftOf(stdio);
    d.rows[1]!.secret = false;
    expect(editPatch(stdio, d)).toEqual({ error: "Enter a value for TOKEN to keep it as a plain variable." });
    d.rows[1]!.value = "abc";
    expect(editPatch(stdio, d)).toEqual({ patch: { env: { LOG: "1", TOKEN: "abc" }, secretEnv: { TOKEN: null } } });
  });

  it("removes a header that was dropped and requires a value for a new one", () => {
    const d = draftOf(http);
    d.rows = [{ key: "X-Team", value: "", secret: true }];
    expect(editPatch(http, d)).toEqual({ error: "Enter a value for X-Team." });
    d.rows[0]!.value = "t1";
    expect(editPatch(http, d)).toEqual({ patch: { headers: { "X-Team": "t1", Authorization: null } } });
  });
});

describe("edit", () => {
  it("sends only what changed, splitting arguments by line and clearing an emptied folder", () => {
    const d = { ...draftOf({ ...stdio, transport: { ...stdio.transport, cwd: "/tmp" } as ConnectorWire["transport"] }), name: "Docs", args: "-y\nserver\n--root My Docs\n", cwd: " " };
    expect(editPatch({ ...stdio, transport: { ...stdio.transport, cwd: "/tmp" } as ConnectorWire["transport"] }, d))
      .toEqual({ patch: { name: "Docs", args: ["-y", "server", "--root My Docs"], cwd: null } });
  });

  it("checks URLs, names and duplicates before sending", () => {
    expect(editPatch(http, { ...draftOf(http), url: "linear" })).toHaveProperty("error");
    expect(editPatch(http, { ...draftOf(http), clientMetadataUrl: "nope" })).toHaveProperty("error");
    expect(editPatch(stdio, { ...draftOf(stdio), command: " " })).toEqual({ error: "Enter the command to run." });
    expect(editPatch(stdio, { ...draftOf(stdio), rows: [{ key: "", value: "x", secret: false }] })).toEqual({ error: "Every variable needs a name." });
    expect(editPatch(stdio, { ...draftOf(stdio), rows: [{ key: "A", value: "1", secret: false }, { key: "A", value: "2", secret: true }] })).toEqual({ error: "A is listed twice." });
  });

  it("sets and clears the client metadata URL", () => {
    expect(editPatch(http, { ...draftOf(http), clientMetadataUrl: "https://a.dev/c.json" })).toEqual({ patch: { clientMetadataUrl: "https://a.dev/c.json" } });
    const withMeta = { ...http, clientMetadataUrl: "https://a.dev/c.json" };
    expect(editPatch(withMeta, { ...draftOf(withMeta), clientMetadataUrl: "" })).toEqual({ patch: { clientMetadataUrl: null } });
  });
});

describe("import selection", () => {
  const t = { type: "http", url: "https://x.dev", headers: [] } as const;
  const sources: ConnectorImportSource[] = [
    { source: "cursor", label: "Cursor", path: "~/.cursor/mcp.json", found: true, servers: [
      { name: "a", transport: t, warnings: [] },
      { name: "b", transport: t, warnings: [], duplicateOf: "a (Cursor)" },
    ] },
    { source: "codex", label: "Codex", path: "~/.codex/config.toml", found: false, servers: [] },
    { source: "vscode", label: "VS Code", path: "mcp.json", found: true, servers: [{ name: "a", transport: t, warnings: ["TOKEN refers to ${TOKEN}; set its value after importing."] }] },
  ];

  it("starts with every server checked except duplicates, told apart by source", () => {
    expect([...initialPicks(sources)]).toEqual([pickKey("cursor", "a"), pickKey("vscode", "a")]);
  });

  it("commits what is checked, in preview order", () => {
    const picks = initialPicks(sources);
    picks.delete(pickKey("cursor", "a"));
    picks.add(pickKey("cursor", "b"));
    expect(pickedItems(sources, picks)).toEqual([{ source: "cursor", name: "b" }, { source: "vscode", name: "a" }]);
    expect(pickedItems(sources, new Set())).toEqual([]);
  });
});

describe("bulk tool switches", () => {
  const tool = (name: string, enabled: boolean) => ({ name, exposedName: name, description: "", readOnly: true, enabled });
  const tools = [tool("a", true), tool("b", false), tool("c", true)];

  it("changes only the tools not already where it puts them", () => {
    expect(bulkTools(tools, false, false)).toEqual({ names: ["a", "c"], label: "Turn all off" });
    expect(bulkTools(tools, false, true)).toEqual({ names: ["b"], label: "Turn all on" });
  });

  it("says when a filter narrows it to the tools shown", () => {
    expect(bulkTools(tools.slice(0, 2), true, true)).toEqual({ names: ["b"], label: "Turn the 2 shown on" });
    expect(bulkTools([], true, false).names).toEqual([]);
  });
});

describe("monogram", () => {
  it("stands for a connector in two letters, whatever its name", () => {
    expect(monogram("GitHub")).toBe("GH");
    expect(monogram("Linear")).toBe("Li");
    expect(monogram("web search")).toBe("WS");
    expect(monogram("api.example.com")).toBe("AE");
    expect(monogram("x")).toBe("X");
    expect(monogram("Ünïcode")).toBe("Ün");
    expect(monogram("***")).toBe("?");
  });
});
