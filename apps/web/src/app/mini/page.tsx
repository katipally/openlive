"use client";

import { useEffect } from "react";
import { PanelMiniBar } from "@/components/live/PanelMiniBar";

// The desktop mini panel window loads this route in its own BrowserWindow.
// Pure display surface: all state arrives over IPC from the main window.
export default function MiniPage() {
  // Tag <html> so globals.css can strip the root chrome (paper grain, toasts)
  // that would otherwise paint behind the chromeless floating pill.
  useEffect(() => {
    document.documentElement.classList.add("mini");
    return () => document.documentElement.classList.remove("mini");
  }, []);
  return <PanelMiniBar />;
}
