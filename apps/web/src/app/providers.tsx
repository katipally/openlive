"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { MotionConfig } from "motion/react";
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { useUi } from "@/lib/uiStore";
import { seedPersisted, type Saved } from "@/lib/persist";
import { migrateLocalStorage } from "@/lib/migrateLocal";
import { warmupOnLaunch } from "@/lib/live/warmup";
import { useAppearanceSync } from "@/lib/look";
import { watchRendererErrors } from "@/lib/rendererError";
import { watchPipelineConfig } from "@/lib/settingChanges";
import { watchWindowShown } from "@/lib/windowShown";

// Inside the ThemeProvider, which it reads the theme from.
function AppearanceSync() {
  useAppearanceSync();
  return null;
}

export function Providers({ saved, children }: { saved: Saved; children: ReactNode }) {
  // Before anything below renders, on the server and in the page alike, so both
  // draw the remembered view and hydration matches.
  useState(() => seedPersisted(saved));
  // Before the first paint the page owns: what an older version left in localStorage.
  useLayoutEffect(() => void migrateLocalStorage(), []);
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: false } } }),
  );
  // Desktop: the native menu (⌘,) opens Settings.
  useEffect(() => {
    (window as unknown as { openlive?: { onOpenSettings?: (cb: () => void) => void } })
      .openlive?.onOpenSettings?.(() => useUi.getState().openSettings());
    // Quietly pre-warm the voice stack (cached weights + shaders + mic driver)
    // so the first call doesn't pay the cold start.
    warmupOnLaunch();
  }, []);
  useEffect(watchRendererErrors, []);
  useEffect(watchPipelineConfig, []);
  useEffect(() => watchWindowShown(client, (window as unknown as { openlive?: { onWindowShown?: (cb: (shown: boolean) => void) => () => void } }).openlive?.onWindowShown), [client]);
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <AppearanceSync />
      {/* Reduce Motion, app-wide: motion drops transforms and layout moves and keeps fades. */}
      <MotionConfig reducedMotion="user">
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </MotionConfig>
    </ThemeProvider>
  );
}
