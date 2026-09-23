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

/** Whether the keyboard in front of the person is a Mac one, which is what
 *  decides whether a key is called "Control" or "Ctrl". The shell's own answer
 *  when there is one; the browser's otherwise. */
export const isMac = desktopPlatform
  ? desktopPlatform === "darwin"
  : typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
/** The primary shortcut modifier as that keyboard labels it. */
export const MOD = isMac ? "⌘" : "Ctrl";
/** Flow's summon key, named the way that keyboard prints it. */
export const CONTROL = isMac ? "Control" : "Ctrl";
export const isWinDesktop = isDesktop && !!desktopPlatform && desktopPlatform !== "darwin";

/** Last path segment for display ("/a/b/c" → "c"); tolerant of trailing slashes
 *  and both separators. `fallback` shows when the path is empty. */
export const basename = (p: string, fallback = ""): string =>
  p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || p || fallback;

/** The Electron preload bridge for OS actions (clipboard / open URL / pick folder),
 *  or undefined in the browser. */
export const bridge: ((op: string, arg?: string) => Promise<string>) | undefined =
  typeof window !== "undefined"
    ? (window as unknown as { openlive?: { bridge?: (op: string, arg?: string) => Promise<string> } }).openlive?.bridge
    : undefined;

/** OS notification via the desktop shell — main process shows it only when the
 *  app isn't focused; a click brings OpenLive forward. No-op in the browser. */
export function notifyDesktop(title: string, body?: string): void {
  if (typeof window === "undefined") return;
  (window as unknown as { openlive?: { notify?: (t: string, b?: string) => void } }).openlive?.notify?.(title, body);
}
