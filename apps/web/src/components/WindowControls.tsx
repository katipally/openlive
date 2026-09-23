"use client";

import { useEffect, useState } from "react";

// Window controls. macOS uses the NATIVE traffic lights (titleBarStyle "hidden" in
// main.cjs) so real OS fullscreen works — nothing to draw there. Windows/Linux are
// frameless, so we draw the native idiom: minimize/maximize/close top-RIGHT as flat
// hover targets. Hidden on the web build and in the orb window (transparent +
// click-through). Also tags <html> with `.desktop` (and `.desktop-win`
// off-mac) so layout can clear the right chrome on the right platform.
type Bridge = { isDesktop?: boolean; platform?: string; winClose?: () => void; winMin?: () => void; winZoom?: () => void; winFullscreen?: () => void };
const ol = (): Bridge | undefined => (typeof window !== "undefined" ? (window as unknown as { openlive?: Bridge }).openlive : undefined);

export function WindowControls() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    if (ol()?.isDesktop) {
      document.documentElement.classList.add("desktop");
      if (ol()?.platform && ol()!.platform !== "darwin") document.documentElement.classList.add("desktop-win");
    }
  }, []);

  // The orb window (/flow) is chromeless: no window controls there.
  const isOrb = mounted && window.location.pathname === "/flow";
  if (!mounted || !ol()?.isDesktop || isOrb) return null;

  if (ol()?.platform && ol()!.platform !== "darwin") {
    // Windows/Linux: flat right-aligned controls in the platform's order.
    const btn = "grid h-9 w-11 place-items-center text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground [-webkit-app-region:no-drag]";
    return (
      <div className="fixed right-0 top-0 z-[var(--z-window)] flex items-stretch [-webkit-app-region:no-drag]">
        <button aria-label="Minimize window" title="Minimize" onClick={() => ol()?.winMin?.()} className={btn}>
          <svg viewBox="0 0 10 10" className="size-2.5"><path d="M0 5h10" stroke="currentColor" strokeWidth="1.2" /></svg>
        </button>
        <button aria-label="Maximize window" title="Maximize" onClick={() => ol()?.winZoom?.()} className={btn}>
          <svg viewBox="0 0 10 10" className="size-2.5" fill="none"><rect x="0.6" y="0.6" width="8.8" height="8.8" stroke="currentColor" strokeWidth="1.2" /></svg>
        </button>
        <button aria-label="Close window" title="Close" onClick={() => ol()?.winClose?.()} className={`${btn} hover:bg-danger hover:text-white`}>
          <svg viewBox="0 0 10 10" className="size-2.5"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1.2" /></svg>
        </button>
      </div>
    );
  }

  // macOS: native traffic lights (see main.cjs). Nothing custom to render.
  return null;
}
