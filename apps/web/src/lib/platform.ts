// Platform helpers shared across components (was re-defined per file).

/** Running inside the OpenLive desktop (Electron) shell. Module-level constant is
 *  safe for components that only render client-side; for SSR'd components that
 *  need hydration-stable markup, gate on mount instead (see AgentControls). */
export const isDesktop = typeof navigator !== "undefined" && /Electron/i.test(navigator.userAgent);

/** OS platform inside the desktop shell ("darwin" | "win32" | "linux"), "" on web. */
export const desktopPlatform: string =
  (typeof window !== "undefined" && (window as unknown as { openlive?: { platform?: string } }).openlive?.platform) || "";

/** macOS desktop: traffic lights live top-LEFT → headers clear ~84px on the left.
 *  Windows/Linux desktop: controls live top-RIGHT → clear the right edge instead. */
export const isMacDesktop = isDesktop && desktopPlatform === "darwin";
export const isWinDesktop = isDesktop && !!desktopPlatform && desktopPlatform !== "darwin";

/** Last path segment for display ("/a/b/c" → "c"); tolerant of trailing slashes
 *  and both separators. `fallback` shows when the path is empty. */
export const basename = (p: string, fallback = ""): string =>
  p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || p || fallback;

/** The user's saved global mini-mode talk hotkey (Settings → General). Read by
 *  PanelBridge on each mini entry so the main process registers the right one. */
const HOTKEY_KEY = "openlive-mini-hotkey";
export function savedMiniHotkey(): string {
  try { return localStorage.getItem(HOTKEY_KEY) || "Alt+Space"; } catch { return "Alt+Space"; }
}
export function saveMiniHotkey(acc: string): void {
  try { localStorage.setItem(HOTKEY_KEY, acc); } catch { /* private mode */ }
}

/** The Electron preload bridge for OS actions (clipboard / open URL / pick folder),
 *  or undefined in the browser. */
export const bridge: ((op: string, arg?: string) => Promise<string>) | undefined =
  typeof window !== "undefined"
    ? (window as unknown as { openlive?: { bridge?: (op: string, arg?: string) => Promise<string> } }).openlive?.bridge
    : undefined;
