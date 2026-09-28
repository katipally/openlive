import type { Metadata } from "next";
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
  description: "Ears, eyes, and a voice for your AI. Bring your own model or talk to your coding agents. The whole voice loop runs on your device.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable}`}>
      <head>
        {/* Before the first paint: the desktop shell says which look this window
            wears, so a glass window never flashes flat. lib/look.ts takes over. */}
        <script dangerouslySetInnerHTML={{ __html: BOOT_LOOK }} />
      </head>
      <body className="h-full antialiased">
        <Providers>{children}</Providers>
        <Toasts />
        {/* Last in the body on purpose: Chromium builds the window's drag region in
            DOM order, so any later `-webkit-app-region: drag` header re-covers these
            controls' no-drag rect and the OS swallows the clicks as window drags. */}
        <WindowControls />
      </body>
    </html>
  );
}
