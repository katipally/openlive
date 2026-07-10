"use client";

import { useEffect, useState } from "react";
import { useUi } from "@/lib/uiStore";

// The window is frameless (see main.cjs), so we draw our own macOS-style controls
// top-left on every screen. Hidden on the web build and while minimized (the mini
// overlay is transparent + click-through). Also tags <html> with `.desktop` so the
// global drag/no-drag CSS applies only in the desktop app.
type Bridge = { isDesktop?: boolean; winClose?: () => void; winMin?: () => void; winZoom?: () => void };
const ol = (): Bridge | undefined => (typeof window !== "undefined" ? (window as unknown as { openlive?: Bridge }).openlive : undefined);

export function WindowControls() {
  const minimized = useUi((s) => s.minimized);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    if (ol()?.isDesktop) document.documentElement.classList.add("desktop");
  }, []);

  if (!mounted || !ol()?.isDesktop || minimized) return null;
  const dot = "size-3 rounded-full transition hover:brightness-125 active:brightness-90 [-webkit-app-region:no-drag]";
  return (
    <div className="fixed left-4 top-[15px] z-[100] flex items-center gap-2">
      <button aria-label="Close window" title="Close" onClick={() => ol()?.winClose?.()} className={`${dot} bg-[#ff5f57]`} />
      <button aria-label="Minimize window" title="Minimize" onClick={() => ol()?.winMin?.()} className={`${dot} bg-[#febc2e]`} />
      <button aria-label="Zoom window" title="Zoom" onClick={() => ol()?.winZoom?.()} className={`${dot} bg-[#28c840]`} />
    </div>
  );
}
