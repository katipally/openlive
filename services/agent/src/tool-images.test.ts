import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_PROVIDERS, withSettings, type Message } from "@openlive/harness";

process.env.OPENLIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "openlive-toolimg-"));
const { prepareToolImages, takesImages } = await import("./tool-images");

const ollama = withSettings(BUILTIN_PROVIDERS.find((p) => p.id === "ollama")!, { ollamaBaseUrl: "http://ollama.test:11434" });
const groq = BUILTIN_PROVIDERS.find((p) => p.id === "groq")!;
const signal = new AbortController().signal;

const shot: Message[] = [
  { role: "user", text: "what is on screen" },
  { role: "assistant", toolCalls: [{ id: "c1", name: "screenshot", arguments: "{}" }] },
  { role: "tool", callId: "c1", name: "screenshot", result: "The screen, 800 by 600.", images: [{ data: "AAA", mime: "image/png" }] },
];

/** Ollama's /api/show for capabilities, and a Chat Completions stream for the vision model's description. */
function serve(capabilities: string[], description = "A Safari window showing apple.com.") {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(String(url));
    if (String(url).endsWith("/api/show")) return Response.json({ capabilities });
    const chunk = { choices: [{ delta: { content: description } }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { status: 200 });
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("takesImages", () => {
  it("asks Ollama at the configured address, and remembers the answer", async () => {
    const calls = serve(["completion", "vision"]);
    expect(await takesImages(ollama, "llava:7b")).toBe(true);
    expect(await takesImages(ollama, "llava:7b")).toBe(true);
    expect(calls).toEqual(["http://ollama.test:11434/api/show"]);
  });

  it("falls back to the picker's heuristic when nothing can say", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await takesImages(ollama, "text-embedding-thing")).toBe(false);
    expect(await takesImages({ ...groq, catalogId: undefined } as typeof groq, "some-chat-model")).toBe(true);
  });
});

describe("prepareToolImages", () => {
  const live = (model: string) => ({ provider: ollama, model, apiKey: null });

  it("leaves pictures in place for a model that sees", async () => {
    serve(["completion", "vision"]);
    expect(await prepareToolImages(shot, live("see:1"), signal, new Map(), () => null)).toBe(shot);
  });

  it("has the vision model describe the picture once, for a model that cannot see", async () => {
    const calls = serve(["completion"]);
    const eyes = { provider: groq, model: "llama-4-scout", apiKey: "k" };
    const described = new Map<string, string>();
    const first = await prepareToolImages(shot, live("blind:1"), signal, described, () => eyes);
    const tool = first[2] as Extract<Message, { role: "tool" }>;
    expect(tool.images).toBeUndefined();
    expect(tool.result).toContain("The screen, 800 by 600.");
    expect(tool.result).toContain("llama-4-scout looked at the picture");
    expect(tool.result).toContain("A Safari window showing apple.com.");
    expect(shot[2]).toHaveProperty("images");
    await prepareToolImages(shot, live("blind:1"), signal, described, () => eyes);
    expect(calls.filter((u) => u.endsWith("/chat/completions"))).toHaveLength(1);
  });

  it("says plainly that no picture was sent when there is nothing to see with", async () => {
    serve(["completion"]);
    const out = await prepareToolImages(shot, live("blind:2"), signal, new Map(), () => null);
    const tool = out[2] as Extract<Message, { role: "tool" }>;
    expect(tool.images).toBeUndefined();
    expect(tool.result).toMatch(/cannot take images, so it was not sent\. Do not describe it or say you can see it/);
  });

  it("falls back to the note when the vision model fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).endsWith("/api/show") ? Response.json({ capabilities: ["completion"] }) : new Response("nope", { status: 400 })));
    const out = await prepareToolImages(shot, live("blind:3"), signal, new Map(), () => ({ provider: groq, model: "v", apiKey: "k" }));
    expect((out[2] as { result: string }).result).toContain("was not sent");
  });
});
