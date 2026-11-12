import { expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Nothing is on the PATH, and the WSL distro has Claude Code and the adapter, so claude-code is the one WSL-hosted row.
vi.mock("@openlive/shared/node", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  widenedPath: () => "/nonexistent",
  wslHostFor: async (_d: string, bins: string[]) => bins.includes("claude") ? { distro: "Ubuntu", path: "/p", bins: {} } : null,
}));

process.env.OPENLIVE_HOME = mkdtempSync(join(tmpdir(), "openlive-agents-"));
const { GET } = await import("./route");

type Row = { id: string; installed: boolean; host?: string; distro?: string; canInstall: boolean; canUpdate: boolean; canUninstall: boolean; canLogout: boolean; credState: string };

it("an agent installed in WSL offers none of the Windows-side actions, and says where it lives", async () => {
  const rows = (await (await GET()).json()) as Row[];
  const claude = rows.find((r) => r.id === "claude-code")!;
  expect(claude).toMatchObject({ installed: true, host: "wsl", distro: "Ubuntu", credState: "unknown", canInstall: false, canUpdate: false, canUninstall: false, canLogout: false });
  const codex = rows.find((r) => r.id === "codex")!;
  expect(codex).toMatchObject({ installed: false, canInstall: true });
  expect(codex.host).toBeUndefined();
});
