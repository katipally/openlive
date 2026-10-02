import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/cn";
import { Tooltip } from "./Tooltip";

/** An info mark beside a label: the help a paragraph would spell out, on hover or keyboard focus. */
export function InfoTip({ label, className }: { label: ReactNode; className?: string }) {
  return (
    <Tooltip label={label} className={cn("shrink-0", className)}>
      <button type="button" aria-label="More info"
        className="grid size-4 place-items-center rounded-full text-faint transition hover:text-foreground">
        <Info aria-hidden className="size-3.5" />
      </button>
    </Tooltip>
  );
}
