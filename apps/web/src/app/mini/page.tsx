import { PanelMiniBar } from "@/components/live/PanelMiniBar";

// The desktop mini panel window loads this route in its own BrowserWindow.
// Pure display surface: all state arrives over IPC from the main window.
export default function MiniPage() {
  return <PanelMiniBar />;
}
