import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENLIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "openlive-settings-"));
const SECRET = "per-launch-secret";
process.env.OPENLIVE_SETTINGS_SECRET = SECRET;
const { GET, PUT } = await import("./route");
const { getSetting } = await import("@openlive/db");

const put = (body: Record<string, string>, headers: Record<string, string> = {}) =>
  PUT(new Request("http://x/api/settings", { method: "PUT", body: JSON.stringify(body), headers }));
const confirmed = { "x-openlive-confirmed": SECRET };

describe("ollamaBaseUrl", () => {
  it("is stored as the server root and read back", async () => {
    const res = await put({ ollamaBaseUrl: " http://192.168.1.20:11434/v1/ " }, confirmed);
    expect(res.status).toBe(200);
    expect(getSetting("ollamaBaseUrl")).toBe("http://192.168.1.20:11434");
    expect(((await GET().json()) as Record<string, string>).ollamaBaseUrl).toBe("http://192.168.1.20:11434");
  });

  it("refuses an address that is not http(s), and keeps the one it had", async () => {
    const res = await put({ ollamaBaseUrl: "localhost:11434" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/http:\/\/ or https:\/\//);
    expect(getSetting("ollamaBaseUrl")).toBe("http://192.168.1.20:11434");
  });

  it("goes back to the default when cleared", async () => {
    await put({ ollamaBaseUrl: "" });
    expect(getSetting("ollamaBaseUrl")).toBe("");
  });

  it("saves this computer's own address without asking", async () => {
    const res = await put({ ollamaBaseUrl: "http://127.0.0.1:11500" });
    expect(res.status).toBe(200);
    expect(getSetting("ollamaBaseUrl")).toBe("http://127.0.0.1:11500");
  });

  it("refuses an address off this computer without the desktop app's confirmation", async () => {
    for (const headers of [{}, { "x-openlive-confirmed": "" }, { "x-openlive-confirmed": "guess" }, { "x-openlive-confirmed": `${SECRET}x` }]) {
      const res = await put({ ollamaBaseUrl: "https://evil.example.com" }, headers);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toMatch(/desktop app/);
    }
    expect(getSetting("ollamaBaseUrl")).toBe("http://127.0.0.1:11500");
  });

  it("stores an address off this computer once the desktop app confirms it", async () => {
    const res = await put({ ollamaBaseUrl: "https://gpu.example.com/ollama/" }, confirmed);
    expect(res.status).toBe(200);
    expect(getSetting("ollamaBaseUrl")).toBe("https://gpu.example.com/ollama");
  });

  it("lets the stored address be saved again as it is, but not swapped for another", async () => {
    expect((await put({ ollamaBaseUrl: "https://gpu.example.com/ollama/v1" })).status).toBe(200);
    expect((await put({ ollamaBaseUrl: "https://gpu.example.com:8443/ollama" })).status).toBe(403);
    expect(getSetting("ollamaBaseUrl")).toBe("https://gpu.example.com/ollama");
  });

  it("refuses every address off this computer when no secret was given to the server", async () => {
    delete process.env.OPENLIVE_SETTINGS_SECRET;
    try {
      expect((await put({ ollamaBaseUrl: "http://10.0.0.5:11434" }, { "x-openlive-confirmed": "" })).status).toBe(403);
      expect((await put({ ollamaBaseUrl: "http://localhost:11434" })).status).toBe(200);
    } finally {
      process.env.OPENLIVE_SETTINGS_SECRET = SECRET;
    }
  });
});
