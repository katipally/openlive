import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Under glass the window is see-through, so a full-window surface only hides
// what it covers through the layer rules in globals.css. These pin the wiring:
// a new full-window surface that forgets its tag leaks the page under it.

const SRC = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");
const tsx = (dir: string): string[] => readdirSync(join(SRC, dir)).flatMap((f) => {
  const p = join(dir, f);
  return statSync(join(SRC, p)).isDirectory() ? tsx(p) : p.endsWith(".tsx") ? [p] : [];
});

describe("layers under glass", () => {
  it("every full-window stage or Settings surface declares what it covers", () => {
    const covers = tsx("components").flatMap((f) =>
      [...read(f).matchAll(/<div[^>]*className="[^"]*fixed inset-0 z-(stage|settings)[^>]*>/g)]
        .map((m) => ({ f, level: m[1], tag: /data-covering="(\w+)"/.exec(m[0])?.[1] })));
    expect(covers.length).toBeGreaterThanOrEqual(3);
    for (const c of covers) expect(c, c.f).toMatchObject({ tag: c.level });
  });

  it("the page puts each layer under its own tag", () => {
    const page = read("app/page.tsx");
    for (const layer of ["view", "stage", "drawer"]) expect(page).toContain(`data-layer="${layer}"`);
  });

  it("hides covered layers only under glass, and never mid look switch", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/html\[data-look="glass"\]:has\(\[data-covering\]\) \[data-layer="view"\]/);
    expect(css).toMatch(/html\[data-look="glass"\]:has\(\[data-covering="settings"\]\) :is\(\[data-layer="stage"\], \[data-layer="drawer"\]\)/);
    expect(css).toMatch(/html\.look-switching \[data-layer\] \{ transition: none !important; \}/);
  });

  it("modals, toasts and the drawer float on the one elevated recipe", () => {
    for (const f of ["components/ui/SidePanel.tsx", "components/Toasts.tsx", "components/SpotlightTour.tsx", "components/ConnectionBanner.tsx"])
      expect(read(f), f).toContain("surface-float");
    // The rest float as the kit's floating panel, which is surface-float.
    for (const f of ["components/flow/FlowSessionModal.tsx", "components/live/AgentControls.tsx", "components/live/ElicitationPrompt.tsx", "components/CommandPalette.tsx", "components/ShortcutsSheet.tsx"])
      expect(read(f), f).toContain("sidePanel(true)");
    expect(tsx("components").filter((f) => read(f).includes("bg-scrim"))).toEqual([]);
  });
});
