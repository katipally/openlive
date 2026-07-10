import { useEffect, useState } from "react";

// The desktop app version, set by the Electron preload (from the release tag).
// Read it AFTER mount, not during render: reading window during render makes the
// server (empty) and the desktop client (a version) disagree and breaks hydration.
export function useAppVersion(): string {
  const [version, setVersion] = useState("");
  useEffect(() => {
    setVersion((window as unknown as { openlive?: { version?: string } }).openlive?.version ?? "");
  }, []);
  return version;
}
