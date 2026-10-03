"use client";

import { useId, useRef } from "react";
import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useUi } from "@/lib/uiStore";
import { useFocusTrap } from "@/lib/useFocusTrap";
import { desktopPlatform, isDesktop, isMac, MOD } from "@/lib/platform";
import { useFlowConfig } from "@/lib/flow/useFlowConfig";
import { hotkeyKeys, liveKeys } from "@/lib/dictate/hotkey";
import { Keycap, Button, Tooltip, groupLabel, SidePanelHeader, sidePanel } from "@/components/ui";
import { cn } from "@/lib/cn";
import { useMotionTokens } from "@/lib/motion";

type Row = { label: string; keys: string[] };
type Group = { title: string; note?: string; rows: Row[] };

// Only what is really bound. Settings and ⌘Q are native menu accelerators and
// the talk keys live in the desktop shell, so the browser build leaves them out.
// Flow's, Dictate's and push to talk's groups come from the person's own keys.
const APP_GROUPS: Group[] = [
  { title: "Anywhere in OpenLive", rows: [
    { label: "Command palette", keys: [MOD, "K"] },
    ...(isDesktop ? [{ label: "Settings", keys: [MOD, ","] }] : []),
    { label: "Keyboard shortcuts", keys: ["?"] },
    ...(isDesktop ? [{ label: `Close to ${isMac ? "menu bar" : "tray"}`, keys: [MOD, "Q"] }] : []),
  ] },
];
const CALL_GROUPS: Group[] = [
  { title: "In a call", rows: [
    { label: "Mute / unmute", keys: ["M"] },
    { label: "Camera on / off", keys: ["C"] },
    { label: "Share screen", keys: ["S"] },
    { label: "Activity panel", keys: ["T"] },
    { label: "History", keys: ["H"] },
    { label: "End call", keys: [MOD, "E"] },
  ] },
];

// The one shortcuts sheet: "?" anywhere in the main window, the palette, or
// Settings → General. Rendered only while open, so focus returns the moment it closes.
export function ShortcutsSheet() {
  const open = useUi((s) => s.shortcutsOpen);
  const setOpen = useUi((s) => s.setShortcutsOpen);
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = () => setOpen(false);
  const { smooth, fade, exit: leave } = useMotionTokens();
  useFocusTrap(ref, open, close);

  return (
    <AnimatePresence>
    {open && (
    // Esc is claimed here, ahead of Settings' own document-level trap, so closing
    // the sheet over Settings leaves Settings open.
    <motion.div key="sheet" ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: leave }} transition={fade}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); close(); } }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
      className={cn("fixed inset-0 z-palette grid place-items-center overflow-y-auto overscroll-contain scrim p-4 text-left", !open && "pointer-events-none")}>
      <motion.div initial={{ opacity: 0, scale: 0.96, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98, transition: leave }}
        transition={{ ...smooth, opacity: fade }}
        className={cn(sidePanel(true), "w-full max-w-[45rem]")}>
        <SidePanelHeader title="Keyboard shortcuts" titleId={titleId}>
          <Tooltip label="Close" keys="Esc">
            <Button variant="ghost" icon size="sm" onClick={close} aria-label="Close"><X /></Button>
          </Tooltip>
        </SidePanelHeader>

        {/* Two columns while they fit, one when the window is narrow: no breakpoint,
            the grid decides from the space it has. */}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,17rem),1fr))] gap-x-8 gap-y-5 border-t border-border px-5 py-5">
          <Groups />
        </div>

        <p className="border-t border-border px-5 py-3 text-caption text-faint">
          Press <Keycap>?</Keycap> anywhere to open this sheet.
        </p>
      </motion.div>
    </motion.div>
    )}
    </AnimatePresence>
  );
}

/** Mounted only while the sheet is open, so the talk keys are read then and not on every page load. */
function Groups() {
  const config = useFlowConfig().config;
  // The keys as the hook watches them: in push to talk, a double-tap key gives up push to talk's side.
  const live = config && liveKeys(config.talk);
  const caps = (k: string) => hotkeyKeys(k, desktopPlatform);
  const twice = (k: string) => [...caps(k), ...caps(k)];
  const anyApp: Group[] = isDesktop && live && config ? [
    { title: "Flow, from any app", rows: [{ label: "Double-tap to open, again to close", keys: twice(live.flow) }] },
    // Dictate's key is bound only while it is on.
    { title: "Dictate, from any app", note: config.dictate.enabled ? undefined : "Off now. Turn it on in Dictate.", rows: [
      { label: "Double-tap to start, again to stop", keys: twice(live.dictate) },
    ] },
  ] : [];
  // Push to talk's key works in Flow, Dictate and a call alike, wherever the key listener runs.
  const talking: Group = { title: "Talking", note: config?.talk.mode === "ptt" ? undefined : "Holding a key to talk needs How you talk set to Push to talk, in Settings > General.", rows: [
    ...(isDesktop && live ? [{ label: "Hold to talk", keys: caps(live.ptt) }] : []),
    { label: "Send a held thought now, in a call", keys: ["Enter"] },
  ] };
  return [...APP_GROUPS, ...anyApp, ...CALL_GROUPS, talking].map((g) => (
    <section key={g.title} className="min-w-0">
      <h3 className={groupLabel}>{g.title}</h3>
      {g.note && <p className="mt-0.5 text-caption text-faint">{g.note}</p>}
      <dl className="mt-2 flex flex-col gap-1.5">
        {g.rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-3 text-label">
            <dt className="min-w-0 break-words text-muted-strong">{r.label}</dt>
            <dd className="flex max-w-full shrink-0 flex-wrap items-center justify-end gap-1">{r.keys.map((k, i) => <Keycap key={i}>{k}</Keycap>)}</dd>
          </div>
        ))}
      </dl>
    </section>
  ));
}
