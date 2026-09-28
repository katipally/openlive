import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

// The app's side panel: an inset card, the window's margin clear on every side,
// with one header (the title, then its icon buttons). Docked, it sits beside the
// page on the card surface (the call's setup and Activity panels); floating, it
// sits over the page on the overlay surface (the sessions drawer, Activity in a
// window too narrow to dock it).

/** The panel's surface and shape. Callers add the placement and the width. */
export const sidePanel = (float?: boolean) => cn("flex min-h-0 flex-col rounded-xl text-left",
  float ? "border border-hairline shadow-pop surface-float" : "bg-card shadow-card");

/** `detail` is a quiet line under the title (when, how long, who answered);
 *  `titleId` lets a dialog name itself by the title. */
export function SidePanelHeader({ title, detail, titleId, children, className }: {
  title: ReactNode; detail?: ReactNode; titleId?: string; children?: ReactNode; className?: string;
}) {
  return (
    <header className={cn("flex min-h-14 shrink-0 items-center gap-1 pl-5 pr-3", detail && "py-3", className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 id={titleId} className="truncate text-title-sm font-semibold tracking-tight">{title}</h2>
        {detail && <p className="truncate text-caption text-muted-foreground">{detail}</p>}
      </div>
      {children}
    </header>
  );
}
