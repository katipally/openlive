// A tiny stdio MCP server for the connector tests: a read-only tool, one that
// changes things and answers in every content kind, and one that asks the
// person a question mid-call. Writes its pid to $FIXTURE_PID_FILE so a test can
// tell whether one copy serves every session.
import { appendFileSync } from "node:fs";
import { Server, inputRequired, acceptedContent } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

if (process.env.FIXTURE_PID_FILE) appendFileSync(process.env.FIXTURE_PID_FILE, `${process.pid}\n`);

const tools = [
  { name: "echo", description: "Say it back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: true } },
  { name: "make.note", description: "Write a note.", inputSchema: { type: "object", properties: { title: { type: "string" } } } },
  { name: "confirm", description: "Ask first.", inputSchema: { type: "object", properties: {} } },
];

serveStdio(() => {
  const server = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", async () => ({ tools }));
  server.setRequestHandler("tools/call", async (req, ctx) => {
    const args = req.params.arguments ?? {};
    if (req.params.name === "echo") return { content: [{ type: "text", text: `echo: ${args.text} (${process.env.FIXTURE_SECRET ?? "no secret"})` }] };
    if (req.params.name === "make.note") return {
      content: [
        { type: "text", text: `noted ${args.title}` },
        { type: "image", data: "UE5H", mimeType: "image/png" },
        { type: "resource_link", uri: "file:///notes/1.md", name: "1.md", description: "the note" },
      ],
    };
    if (req.params.name === "confirm") {
      const answer = acceptedContent(ctx.mcpReq.inputResponses, "ok");
      if (!answer) return inputRequired({ inputRequests: { ok: inputRequired.elicit({ message: "Go ahead?", requestedSchema: { type: "object", properties: { sure: { type: "boolean" } }, required: ["sure"] } }) } });
      return { content: [{ type: "text", text: `sure=${answer.sure}` }] };
    }
    return { isError: true, content: [{ type: "text", text: "no such tool" }] };
  });
  return server;
});
