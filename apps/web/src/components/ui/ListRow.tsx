import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

// Grouped list rows, as in the system settings apps: one card, hairlines
// between rows, a label (and an optional line under it) on the left and the
// row's control on the right. The control wraps under the label when the
// window is too narrow for both.

/** The heading over a run of rows (TODAY, YESTERDAY) or a menu's items: the one
 *  small-caps label every list and panel uses. Add only spacing. */
export const groupLabel = "text-micro font-medium uppercase tracking-[0.06em] text-muted-foreground";

export function ListGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-col divide-y divide-border rounded-lg bg-card px-card-x shadow-card", className)}>{children}</div>;
}

/** `asLabel` makes the whole row a <label>, so a click anywhere flips its switch. */
export function ListRow({ label, detail, children, asLabel, className }: {
  label: ReactNode; detail?: ReactNode; children?: ReactNode; asLabel?: boolean; className?: string;
}) {
  const Row = asLabel ? "label" : "div";
  return (
    <Row className={cn("flex min-h-row flex-wrap items-center gap-x-4 gap-y-2 py-2", asLabel && "cursor-pointer select-none", className)}>
      <span className="flex min-w-[8rem] flex-1 flex-col gap-0.5">
        <span className="break-words text-body text-foreground">{label}</span>
        {detail && <span className="break-words text-label text-muted-foreground">{detail}</span>}
      </span>
      {children}
    </Row>
  );
}
