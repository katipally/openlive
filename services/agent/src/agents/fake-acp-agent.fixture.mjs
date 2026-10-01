// A scripted ACP agent over stdio for acp-agent.test.ts: advertises list and
// resume, slash commands and a boolean config option, and echoes each prompt's
// blocks back as its reply so the test can see exactly what was sent. Flags pick
// an agent's quirks: --legacy-models (models as session state, set by
// session/set_model), --no-http-mcp (advertises it takes no http MCP; any agent
// echoes the MCP servers it was given on "[mcp]"), --auth-required (session/new says auth_required).
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";

const SESSIONS = Array.from({ length: 5 }, (_, i) => ({
  sessionId: `s${i}`, cwd: "/work", title: i === 2 ? null : `Session ${i}`, updatedAt: new Date(Date.UTC(2026, 8, 1 + i)).toISOString(),
}));
const flags = new Set(process.argv.slice(2));
let fast = false;
let servers = [];
let legacyModel = "m1";
const config = () => [
  ...flags.has("--legacy-models") ? [] : [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "m1", options: [{ value: "m1", name: "One" }] }],
  { id: "fast", name: "Fast mode", type: "boolean", currentValue: fast },
];
const models = () => flags.has("--legacy-models")
  ? { models: { availableModels: [{ modelId: "m1", name: "One" }, { modelId: "m2", name: "Two" }], currentModelId: legacyModel } }
  : {};

let conn;
const text = (sessionId, t) => conn.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text: t } } });
const commands = (sessionId) => conn.sessionUpdate({ sessionId, update: {
  sessionUpdate: "available_commands_update",
  availableCommands: [{ name: "compact", description: "Compact the context" }, { name: "review", description: "Review changes", input: { hint: "what to review" } }],
} });

conn = new AgentSideConnection(() => ({
  initialize: async () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {} }, ...flags.has("--no-http-mcp") && { mcpCapabilities: { http: false } } },
  }),
  extMethod: async (method, p) => {
    if (method !== "session/set_model") throw RequestError.methodNotFound(method);
    legacyModel = p.modelId;
    return {};
  },
  newSession: async (p) => {
    if (flags.has("--auth-required")) throw RequestError.authRequired();
    servers = p.mcpServers;
    setTimeout(() => void commands("new"), 0);
    return { sessionId: "new", configOptions: config(), ...models() };
  },
  resumeSession: async (p) => {
    if (p.sessionId === "gone" || p.sessionId === "lost") throw new Error("no such session");
    setTimeout(() => void commands(p.sessionId), 0);
    return { configOptions: config(), ...models(), _meta: { how: "resume" } };
  },
  loadSession: async (p) => {
    if (p.sessionId === "lost") throw new Error("no such session");
    await conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "loaded" } } });
    return { configOptions: config() };
  },
  listSessions: async (p) => {
    const at = Number(p.cursor ?? 0);
    return { sessions: SESSIONS.slice(at, at + 2), nextCursor: at + 2 < SESSIONS.length ? String(at + 2) : null };
  },
  setSessionConfigOption: async (p) => {
    if (p.configId === "fast") fast = p.type === "boolean" ? p.value : "not typed";
    return { configOptions: config() };
  },
  authenticate: async () => ({}),
  prompt: async (p) => {
    const first = p.prompt[0]?.text ?? "";
    if (first.includes("[refuse]")) return { stopReason: "refusal" };
    if (first.includes("[reject]")) throw new RequestError(-32000, "model not allowed");
    if (first.includes("[mcp]")) { await text(p.sessionId, JSON.stringify(servers.map((s) => s.name))); return { stopReason: "end_turn" }; }
    await text(p.sessionId, JSON.stringify(p.prompt.map((b) => b.text ?? b.type)));
    return { stopReason: "end_turn" };
  },
  cancel: async () => {},
}), ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
