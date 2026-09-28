"use client";

import { useEffect, useState } from "react";
import { Tooltip } from "@/components/ui";

// Window controls. macOS uses the NATIVE traffic lights (titleBarStyle "hidden" in
// main.cjs) so real OS fullscreen works: nothing to draw there. Windows/Linux are
// frameless, so we draw each one's idiom top-RIGHT: flat caption buttons on
// Windows, round ones on Linux. Hidden on the web build and in the orb window
// (transparent + click-through). Also tags <html> with `.desktop` (and `.desktop-win`
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

  if (ol()?.platform === "linux") {
    // Linux: GNOME's idiom, small round buttons with air between them.
    const btn = "grid size-6 place-items-center rounded-full bg-foreground/10 text-foreground transition hover:bg-foreground/20 [-webkit-app-region:no-drag]";
    return (
      <div className="fixed right-3 top-2.5 z-window flex items-center gap-3 [-webkit-app-region:no-drag]">
        <Tooltip label="Minimize"><button aria-label="Minimize window" onClick={() => ol()?.winMin?.()} className={btn}>
          <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 12h14" /></svg>
        </button></Tooltip>
        <Tooltip label="Maximize"><button aria-label="Maximize window" onClick={() => ol()?.winZoom?.()} className={btn}>
          <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="2"><rect width="14" height="14" x="5" y="5" rx="1" /></svg>
        </button></Tooltip>
        <Tooltip label="Close"><button aria-label="Close window" onClick={() => ol()?.winClose?.()} className={btn}>
          <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button></Tooltip>
      </div>
    );
  }

  if (ol()?.platform && ol()!.platform !== "darwin") {
    // Windows: flat caption buttons at the system's own 46 x 32, red close on hover.
    const btn = "grid h-8 w-[46px] place-items-center text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground [-webkit-app-region:no-drag]";
    return (
      <div className="fixed right-0 top-0 z-window flex items-stretch [-webkit-app-region:no-drag]">
        <Tooltip label="Minimize"><button aria-label="Minimize window" onClick={() => ol()?.winMin?.()} className={btn}>
          <svg viewBox="0 0 10 10" className="size-2.5"><path d="M0 5h10" stroke="currentColor" strokeWidth="1.2" /></svg>
        </button></Tooltip>
        <Tooltip label="Maximize"><button aria-label="Maximize window" onClick={() => ol()?.winZoom?.()} className={btn}>
          <svg viewBox="0 0 10 10" className="size-2.5" fill="none"><rect x="0.6" y="0.6" width="8.8" height="8.8" stroke="currentColor" strokeWidth="1.2" /></svg>
        </button></Tooltip>
        <Tooltip label="Close"><button aria-label="Close window" onClick={() => ol()?.winClose?.()} className={`${btn} hover:bg-destructive-fill hover:text-white`}>
          <svg viewBox="0 0 10 10" className="size-2.5"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1.2" /></svg>
        </button></Tooltip>
      </div>
    );
  }

  // macOS: native traffic lights (see main.cjs). Nothing custom to render.
  return null;
}
