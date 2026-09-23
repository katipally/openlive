"use client";

import { useId, useRef } from "react";
import { X } from "lucide-react";
import { useUi } from "@/lib/uiStore";
import { useFocusTrap } from "@/lib/useFocusTrap";
import { CONTROL, isDesktop, isMac, MOD } from "@/lib/platform";
import { Keycap } from "./Keycap";

type Row = { label: string; keys: string[] };

// Only what is really bound. Settings and ⌘Q are native menu accelerators and
// Flow's gesture lives in the desktop shell, so the browser build leaves them out.
const GROUPS: { title: string; note?: string; rows: Row[] }[] = [
  { title: "Anywhere in OpenLive", rows: [
    { label: "Command palette", keys: [MOD, "K"] },
    ...(isDesktop ? [{ label: "Settings", keys: [MOD, ","] }] : []),
    { label: "Keyboard shortcuts", keys: ["?"] },
    ...(isDesktop ? [{ label: `Close to ${isMac ? "menu bar" : "tray"}`, keys: [MOD, "Q"] }] : []),
  ] },
  ...(isDesktop ? [{ title: "Flow, from any app", rows: [
    { label: "Talk, then again to close", keys: [CONTROL, CONTROL] },
  ] }] : []),
  { title: "In a call", rows: [
    { label: "Mute / unmute", keys: ["M"] },
    { label: "Camera on / off", keys: ["C"] },
    { label: "Share screen", keys: ["S"] },
    { label: "Activity panel", keys: ["T"] },
    { label: "Sessions", keys: ["H"] },
    { label: "End call", keys: [MOD, "E"] },
  ] },
  { title: "Talking", note: "Once push-to-talk is on in a call.", rows: [
    { label: "Push-to-talk, hold or tap", keys: ["Space"] },
    { label: "Send a held thought now", keys: ["Enter"] },
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
  useFocusTrap(ref, open, close);
  if (!open) return null;

  return (
    // Esc is claimed here, ahead of Settings' own document-level trap, so closing
    // the sheet over Settings leaves Settings open.
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); close(); } }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
      className="animate-fade-in fixed inset-0 z-[var(--z-palette)] grid place-items-center overflow-y-auto bg-black/30 p-4 text-left">
      <div className="animate-modal-in w-full max-w-[720px] rounded-2xl border border-border bg-popover p-5 shadow-[var(--shadow-pop)]">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-title-sm font-semibold text-foreground">Keyboard shortcuts</h2>
          <button type="button" onClick={close} aria-label="Close" title="Close (Esc)"
            className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>

        {/* Two columns while they fit, one when the window is narrow: no breakpoint,
            the grid decides from the space it has. */}
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,17rem),1fr))] gap-x-8 gap-y-5">
          {GROUPS.map((g) => (
            <section key={g.title} className="min-w-0">
              <h3 className="text-caption font-medium uppercase tracking-wide text-faint">{g.title}</h3>
              {g.note && <p className="mt-0.5 text-caption text-faint">{g.note}</p>}
              <dl className="mt-2 flex flex-col gap-1.5">
                {g.rows.map((r) => (
                  <div key={r.label} className="flex items-center justify-between gap-3 text-label">
                    <dt className="min-w-0 break-words text-muted-strong">{r.label}</dt>
                    <dd className="flex shrink-0 items-center gap-1">{r.keys.map((k, i) => <Keycap key={i}>{k}</Keycap>)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>

        <p className="mt-5 border-t border-border pt-3 text-caption text-faint">
          Press <Keycap>?</Keycap> anywhere to open this sheet.
        </p>
      </div>
    </div>
  );
}
