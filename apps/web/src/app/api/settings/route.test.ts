import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENLIVE_DATA_DIR = mkdtempSync(join(tmpdir(), "openlive-settings-"));
const { GET, PUT } = await import("./route");
const { getSetting } = await import("@openlive/db");

const put = (body: Record<string, string>) =>
  PUT(new Request("http://x/api/settings", { method: "PUT", body: JSON.stringify(body) }));

describe("ollamaBaseUrl", () => {
  it("is stored as the server root and read back", async () => {
    const res = await put({ ollamaBaseUrl: " http://192.168.1.20:11434/v1/ " });
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
});
