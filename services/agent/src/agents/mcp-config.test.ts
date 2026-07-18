// .mcp.json passthrough must be forgiving: a user's hand-edited config can't be
// allowed to break the ACP handshake, and transports the agent didn't advertise
// must not be sent.
import { expect, test } from "vitest";
import { parseMcpJson } from "./mcp-config.ts";

const CAPS = { http: true, sse: false };

test("parses stdio and http servers; env/headers become name/value pairs", () => {
  const raw = JSON.stringify({
    mcpServers: {
      files: { command: "npx", args: ["-y", "some-mcp"], env: { TOKEN: "t" } },
      search: { type: "http", url: "https://mcp.example.com", headers: { Authorization: "Bearer x" } },
    },
  });
  expect(parseMcpJson(raw, CAPS)).toEqual([
    { name: "files", command: "npx", args: ["-y", "some-mcp"], env: [{ name: "TOKEN", value: "t" }] },
    { type: "http", name: "search", url: "https://mcp.example.com", headers: [{ name: "Authorization", value: "Bearer x" }] },
  ]);
});

test("transports the agent didn't advertise are skipped; garbage never throws", () => {
  const raw = JSON.stringify({ mcpServers: { s: { type: "sse", url: "https://x" }, ok: { command: "bin" } } });
  const out = parseMcpJson(raw, CAPS); // sse not advertised
  expect(out).toEqual([{ name: "ok", command: "bin", args: [], env: [] }]);
  expect(parseMcpJson("not json {", CAPS)).toEqual([]);
  expect(parseMcpJson("{}", CAPS)).toEqual([]);
  expect(parseMcpJson(JSON.stringify({ mcpServers: { bad: { args: [1] } } }), CAPS)).toEqual([]);
});

test("caps the server count at 20", () => {
  const servers = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`s${i}`, { command: "bin" }]));
  expect(parseMcpJson(JSON.stringify({ mcpServers: servers }), CAPS)).toHaveLength(20);
});
