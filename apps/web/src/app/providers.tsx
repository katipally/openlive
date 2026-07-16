"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useEffect, useState, type ReactNode } from "react";
import { useUi } from "@/lib/uiStore";
import { warmupOnLaunch } from "@/lib/live/warmup";

export function Providers({ children }: { children: ReactNode }) {
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
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </ThemeProvider>
  );
}
