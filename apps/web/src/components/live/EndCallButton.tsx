"use client";

import { useRef } from "react";
import { PhoneOff } from "lucide-react";
import { cn } from "@/lib/cn";
import { menuItem, menuPanel, useMenu, Button, Tooltip } from "@/components/ui";
import { isMac } from "@/lib/platform";

// The red hang-up, gated by a small "End call?" popover so a stray click doesn't
// drop a live call. Cancel takes focus first, so a stray Enter keeps the call.
export function EndCallButton({ onEnd }: { onEnd: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { open, mounted, requestClose, toggle } = useMenu(ref, menuRef);

  return (
    <div ref={ref} className="relative">
      {mounted && (
        // Outer div owns the centering transform; inner (menuRef) owns the pop
        // animation, so its transforms don't clobber -translate-x-1/2.
        <div className="absolute bottom-full left-1/2 z-overlay mb-2 -translate-x-1/2">
          <div ref={menuRef} role="menu" aria-label="End call?" className={cn("w-44", menuPanel)}>
            <p aria-hidden className="px-1 pb-2 pt-0.5 text-center text-label text-foreground">End call?</p>
            <div className="flex gap-1.5">
              <button role="menuitem" onClick={() => requestClose()}
                className={cn(menuItem, "flex-1 justify-center text-label text-muted-foreground")}>Cancel</button>
              <button role="menuitem" onClick={() => { requestClose(); onEnd(); }}
                className={cn(menuItem, "flex-1 justify-center bg-destructive-fill text-label font-medium text-white hover:bg-destructive-fill hover:brightness-110")}>End</button>
            </div>
          </div>
        </div>
      )}
      <Tooltip label="End call" keys={isMac ? "⌘E" : "Ctrl+E"}>
        <Button variant="destructive" icon size="lg" onClick={toggle} aria-label="End call"
          aria-haspopup="menu" aria-expanded={open}
          className="w-14 [&_svg]:transition-transform [&_svg]:duration-spring [&_svg]:ease-spring enabled:hover:[&_svg]:-rotate-12 aria-expanded:[&_svg]:-rotate-12">
          <PhoneOff />
        </Button>
      </Tooltip>
    </div>
  );
}
