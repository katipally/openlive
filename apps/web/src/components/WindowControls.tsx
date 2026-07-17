"use client";

import { useEffect, useState } from "react";
import { useUi } from "@/lib/uiStore";

// The window is frameless (see main.cjs), so we draw our own window controls:
// macOS gets traffic-light dots top-LEFT; Windows/Linux get the native idiom —
// minimize/maximize/close top-RIGHT as flat hover targets. Hidden on the web
// build and while minimized (the mini overlay is transparent + click-through).
// Also tags <html> with `.desktop` (and `.desktop-win` off-mac) so layout can
// clear the right chrome on the right platform.
type Bridge = { isDesktop?: boolean; platform?: string; winClose?: () => void; winMin?: () => void; winZoom?: () => void };
const ol = (): Bridge | undefined => (typeof window !== "undefined" ? (window as unknown as { openlive?: Bridge }).openlive : undefined);

export function WindowControls() {
  const minimized = useUi((s) => s.minimized);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    if (ol()?.isDesktop) {
      document.documentElement.classList.add("desktop");
      if (ol()?.platform && ol()!.platform !== "darwin") document.documentElement.classList.add("desktop-win");
    }
  }, []);

  // The mini panel window (/mini) is a chromeless pill — no window controls there.
  const isPanel = mounted && window.location.pathname.startsWith("/mini");
  if (!mounted || !ol()?.isDesktop || minimized || isPanel) return null;

  if (ol()?.platform && ol()!.platform !== "darwin") {
    // Windows/Linux: flat right-aligned controls in the platform's order.
    const btn = "grid h-9 w-11 place-items-center text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground [-webkit-app-region:no-drag]";
    return (
      <div className="fixed right-0 top-0 z-[100] flex items-stretch">
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

  const dot = "size-3 rounded-full transition hover:brightness-125 active:brightness-90 [-webkit-app-region:no-drag]";
  return (
    <div className="fixed left-4 top-[15px] z-[100] flex items-center gap-2">
      <button aria-label="Close window" title="Close" onClick={() => ol()?.winClose?.()} className={`${dot} bg-[#ff5f57]`} />
      <button aria-label="Minimize window" title="Minimize" onClick={() => ol()?.winMin?.()} className={`${dot} bg-[#febc2e]`} />
      <button aria-label="Zoom window" title="Zoom" onClick={() => ol()?.winZoom?.()} className={`${dot} bg-[#28c840]`} />
    </div>
  );
}
