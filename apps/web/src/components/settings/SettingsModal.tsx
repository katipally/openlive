"use client";

import { useRef } from "react";
import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useUi } from "@/lib/uiStore";
import { useAppVersion } from "@/lib/useAppVersion";
import { ModelsSettings } from "./ModelsSettings";
import { overlay, modal } from "@/lib/motion";
import { useFocusTrap } from "@/lib/useFocusTrap";

export function SettingsModal() {
  const appVersion = useAppVersion();
  const open = useUi((s) => s.settingsOpen);
  const close = useUi((s) => s.closeSettings);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open, close);

  return (
    <AnimatePresence>
      {open && (
        <motion.div variants={overlay} initial="hidden" animate="show" exit="exit"
          className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={close}>
          <motion.div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Settings" tabIndex={-1}
            variants={modal} className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-background text-left shadow-2xl outline-none" onClick={(e) => e.stopPropagation()}>
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
              <span className="flex items-baseline gap-2 text-[14px] font-semibold">
                Settings
                {appVersion && <span className="text-[11px] font-normal text-muted-foreground">v{appVersion}</span>}
              </span>
              <button onClick={close} aria-label="Close settings" className="grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground"><X className="size-4" /></button>
            </div>
            <div className="takt-scroll min-h-0 flex-1 overflow-y-auto p-6">
              <ModelsSettings />
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
