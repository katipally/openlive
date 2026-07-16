// Platform helpers shared across components (was re-defined per file).

/** Running inside the OpenLive desktop (Electron) shell. Module-level constant is
 *  safe for components that only render client-side; for SSR'd components that
 *  need hydration-stable markup, gate on mount instead (see AgentControls). */
export const isDesktop = typeof navigator !== "undefined" && /Electron/i.test(navigator.userAgent);

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
