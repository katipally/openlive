import type { Metadata } from "next";
import { connection } from "next/server";
import { chatExists, readUiState } from "@openlive/db";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "./providers";
import { WindowControls } from "@/components/WindowControls";
import { Toasts } from "@/components/Toasts";
import "./globals.css";

// Bundled at BUILD time by next/font (self-hosted, no runtime fetch): the same
// Geist files ship inside the app, so type renders identically on macOS and
// Windows — the layout's spacing was designed around Geist metrics.
const geistSans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

const BOOT_LOOK = `try{var a=window.openlive&&window.openlive.appearance&&window.openlive.appearance.get();if(a&&a.look==="glass")document.documentElement.dataset.look="glass"}catch(e){}`;

export const metadata: Metadata = {
  title: "OpenLive",
  description: "Talk to any AI. It talks back, sees, and gets things done. Voice, vision and computer use for any AI agent, with the voice loop running on your device.",
};

/** What ui.json remembers, minus an open chat that has since been deleted:
 *  the window comes back to the home instead. */
function remembered() {
  const groups = readUiState();
  const chat = groups.ui?.openChat;
  if (typeof chat === "string") {
    let there = false;
    try { there = chatExists(chat); } catch { /* the database cannot be read: the home it is */ }
    if (!there) delete groups.ui!.openChat;
  }
  return groups;
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Read per request, never at build: the first HTML is the view the person left.
  await connection();
  return (
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable}`}>
      <head>
        {/* Before the first paint: the desktop shell says which look this window
            wears, so a glass window never flashes flat. lib/look.ts takes over. */}
        <script dangerouslySetInnerHTML={{ __html: BOOT_LOOK }} />
      </head>
      <body className="h-full antialiased">
        <Providers saved={remembered()}>{children}</Providers>
        <Toasts />
        {/* Last in the body on purpose: Chromium builds the window's drag region in
            DOM order, so any later `-webkit-app-region: drag` header re-covers these
            controls' no-drag rect and the OS swallows the clicks as window drags. */}
        <WindowControls />
      </body>
    </html>
  );
}
