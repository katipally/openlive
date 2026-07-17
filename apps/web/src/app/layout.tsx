import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Providers } from "./providers";
import { WindowControls } from "@/components/WindowControls";
import { Toasts } from "@/components/Toasts";
import "./globals.css";

const geistSans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: "OpenLive",
  description: "Ears, eyes, and a voice for your AI. Bring your own model or talk to your coding agents — the whole voice loop runs on your device.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="h-full antialiased">
        <WindowControls />
        <Providers>{children}</Providers>
        <Toasts />
      </body>
    </html>
  );
}
