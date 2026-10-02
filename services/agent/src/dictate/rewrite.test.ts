import { describe, expect, it, vi } from "vitest";
import type { ProviderEvent } from "@openlive/harness";
import type { SseEvent } from "@openlive/shared";
import { agentRewrite, apiRewrite, asTyped, rewritePrompt, typedStream } from "./rewrite.js";

const provider = { id: "openai", name: "OpenAI", protocol: "openai-chat" as const, baseURL: "http://x" };
const live = { provider, model: "m", apiKey: "k" };
const signal = new AbortController().signal;
const polish = { kind: "polish" as const, text: "so um send it friday", tone: "formal" as const };
const quiet = () => {};
/** What `typedStream` hands on for `deltas`, piece by piece. */
const pieces = (deltas: string[]) => { const out: string[] = []; const push = typedStream((t) => out.push(t)); deltas.forEach(push); return out; };

/** A provider that says `events`, or fails partway when one is an Error. */
const streamOf = (events: (ProviderEvent | Error)[]) => vi.fn(async function* () {
  for (const e of events) { if (e instanceof Error) throw e; yield e; }
});

describe("the rewrite prompt", () => {
  it("polishes in the chosen tone, as text that is not a message to the brain", () => {
    const { system, user } = rewritePrompt(polish);
    expect(system).toMatch(/professional/);
    expect(system).toMatch(/never answer it/);
    expect(system).toMatch(/Use no tools/);
    expect(user).toBe("<dictation>\nso um send it friday\n</dictation>");
  });

  it("applies a command to the selection, or writes fresh text with none", () => {
    expect(rewritePrompt({ kind: "command", text: "make it formal", selection: "hey" }).user).toBe("Instruction: make it formal\n\n<selection>\nhey\n</selection>");
    expect(rewritePrompt({ kind: "command", text: "write a haiku", selection: "" }).user).toMatch(/No text is selected/);
  });

  it("types the reply without a wrapping code fence", () => {
    expect(asTyped("```text\nHello there.\n```")).toBe("Hello there.");
    expect(asTyped("  Plain.  ")).toBe("Plain.");
  });
});

describe("the reply as it streams", () => {
  it("hands on the words as they come, the blank space at either end held back", () => {
    expect(pieces(["\n Send it ", "on Fri", "day.\n"])).toEqual(["Send it", " on Fri", "day."]);
    expect(pieces(["\n Send it ", "on Fri", "day.\n"]).join("")).toBe(asTyped("\n Send it on Friday.\n"));
  });

  it("holds a reply that opens with a code fence whole, for asTyped to unwrap", () => {
    expect(pieces(["``", "`text\nHello", "\n```"])).toEqual([]);
    expect(pieces(["`x` is a name."])).toEqual(["`x` is a name."]);
  });
});

describe("an API brain", () => {
  it("offers no tools and keeps only the words", async () => {
    const stream = streamOf([{ type: "text", delta: "Send it " }, { type: "reasoning", delta: "hmm" }, { type: "text", delta: "on Friday." }, { type: "done", stopReason: "stop" }]);
    expect(await apiRewrite(polish, signal, quiet, live, stream)).toBe("Send it on Friday.");
    expect((stream.mock.calls[0] as unknown[])[2]).toMatchObject({ tools: [] });
  });

  it("hands on its words as they stream", async () => {
    const got: string[] = [];
    await apiRewrite(polish, signal, (t) => got.push(t), live, streamOf([{ type: "text", delta: "Send it " }, { type: "text", delta: "on Friday." }, { type: "done", stopReason: "stop" }]));
    expect(got).toEqual(["Send it", " on Friday."]);
  });

  it("rejects when the provider fails, so Dictate falls back to its own text", async () => {
    await expect(apiRewrite(polish, signal, quiet, live, streamOf([{ type: "text", delta: "Half" }, new Error("503")]))).rejects.toThrow("503");
  });

  it("rejects without a key rather than sending a request that can only be refused", async () => {
    await expect(apiRewrite(polish, signal, quiet, { ...live, apiKey: null }, streamOf([]))).rejects.toThrow(/No API key/);
  });
});

describe("a coding agent brain", () => {
  const agent = (events: SseEvent[]) => ({ runTurn: vi.fn(async (_input: unknown, emit: (e: SseEvent) => void) => { events.forEach(emit); }) });

  it("keeps its words and ignores its own tool activity", async () => {
    const a = agent([
      { type: "acp_tool_call", call: { id: "t", title: "Read", kind: "read", status: "pending", locations: [] } } as unknown as SseEvent,
      { type: "text_delta", text: "Send it on Friday." },
    ]);
    expect(await agentRewrite(polish, a, signal)).toBe("Send it on Friday.");
    expect((a.runTurn.mock.calls[0] as unknown[])[0]).toMatchObject({ frames: [] });
  });

  it("hands on its words as they stream, and none after an error", async () => {
    const got: string[] = [];
    await agentRewrite(polish, agent([{ type: "text_delta", text: "Send it " }, { type: "text_delta", text: "on Friday." }]), signal, (t) => got.push(t));
    expect(got).toEqual(["Send it", " on Friday."]);
    const cut: string[] = [];
    await expect(agentRewrite(polish, agent([{ type: "text_delta", text: "Sen" }, { type: "error", message: "rate limited" }, { type: "text_delta", text: "d" }]), signal, (t) => cut.push(t))).rejects.toThrow();
    expect(cut).toEqual(["Sen"]);
  });

  it("rejects on the agent's error, so Dictate falls back to its own text", async () => {
    await expect(agentRewrite(polish, agent([{ type: "text_delta", text: "Sen" }, { type: "error", message: "rate limited" }]), signal)).rejects.toThrow("rate limited");
  });

  it("rejects once Dictate's deadline has cut the turn", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(agentRewrite(polish, agent([{ type: "text_delta", text: "Sen" }]), ac.signal)).rejects.toThrow(/cancelled/);
  });
});
