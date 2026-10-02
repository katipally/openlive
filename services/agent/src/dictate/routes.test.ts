import { describe, expect, it, vi } from "vitest";

vi.mock("./rewrite.js", () => ({
  warm: vi.fn(),
  rewrite: vi.fn(async (ask: { text: string }, _signal: AbortSignal, onText: (t: string) => void) => {
    if (ask.text === "fail") { onText("Half"); throw new Error("rate limited"); }
    onText("Send it");
    onText(" on Friday.");
    return "Send it on Friday.";
  }),
}));

const { dictateRoutes } = await import("./routes.js");

const lines = async (text: string) => {
  const res = await dictateRoutes.request("/rewrite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "polish", text, tone: "formal" }) });
  return (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as unknown);
};

describe("POST /rewrite", () => {
  it("streams the words a line at a time, then the whole", async () => {
    expect(await lines("send it friday")).toEqual([{ delta: "Send it" }, { delta: " on Friday." }, { text: "Send it on Friday." }]);
  });

  it("ends with the error when the brain fails partway", async () => {
    expect(await lines("fail")).toEqual([{ delta: "Half" }, { error: "rate limited" }]);
  });
});
