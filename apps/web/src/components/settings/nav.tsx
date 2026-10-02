"use client";

import { createContext, useContext, type ReactNode } from "react";
import { ChevronRight, Link2, type LucideIcon } from "lucide-react";
import type { SettingsTabId } from "@/lib/settingsSearch";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui";
import { tile } from "./common";

/** Go to a tab, and optionally bring a row into view (and click `reveal` first,
 *  a stage tab that holds it), as a picked search result does. */
export type SettingsGo = (tab: SettingsTabId, anchor?: string, reveal?: string) => void;
export const SettingsNav = createContext<SettingsGo>(() => {});
export const useSettingsNav = () => useContext(SettingsNav);

/** A row that shows a value set somewhere else and goes there, instead of a
 *  second copy of the control. `shared` marks the value as Chat and Flow's. */
export function LinkRow({ label, detail, value, onGo, shared = true, icon: Icon, className }: {
  label: ReactNode; detail?: ReactNode; value: ReactNode; onGo: () => void; shared?: boolean; icon?: LucideIcon; className?: string;
}) {
  return (
    <button type="button" onClick={onGo}
      className={cn("group flex min-h-row w-full flex-wrap items-center gap-x-4 gap-y-1 py-2 text-left", className)}>
      {Icon && <span className={tile}><Icon aria-hidden /></span>}
      <span className="flex min-w-[8rem] flex-1 flex-col gap-0.5">
        <span className="break-words text-body text-foreground">{label}</span>
        {detail && (
          <Tooltip label={detail} truncated className="flex min-w-0 max-w-full">
            <span className="min-w-0 truncate text-label text-muted-foreground">{detail}</span>
          </Tooltip>
        )}
      </span>
      <span className="flex min-w-0 max-w-full items-center gap-1.5 text-body text-muted-foreground transition group-hover:text-foreground">
        {shared && <Link2 aria-label="Shared with Chat" className="size-3.5 shrink-0 text-link-foreground" />}
        <span className="min-w-0 break-words">{value}</span>
        <ChevronRight aria-hidden className="size-4 shrink-0" />
      </span>
    </button>
  );
}
