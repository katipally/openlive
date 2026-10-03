"use client";

import type { ReactNode } from "react";
import { Tooltip, pill } from "@/components/ui";
import { flowBridge, type FlowCapabilities, type FlowPermissionName } from "@/lib/flow/bridge";
import { isMac } from "@/lib/platform";
import { MODE_LABEL, type AppMode } from "@/lib/uiStore";
import { cn } from "@/lib/cn";

// The fix for what a mode is missing, on its home, as a pill you press: the
// same pill in Chat, Flow and Dictate.

/** A pill that fixes something, marked with the needs-you dot. */
export function FixPill({ tip, onClick, tour, children }: { tip: string; onClick: () => void; tour?: string; children: ReactNode }) {
  return (
    <Tooltip label={tip} className="min-w-0 max-w-full">
      <button type="button" data-tour={tour} onClick={onClick} className={cn(pill, "min-w-0 max-w-full")}>
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-arc" />
        <span className="min-w-0 truncate">{children}</span>
      </button>
    </Tooltip>
  );
}

/** What Flow or Dictate still needs from this machine. Empty while nothing is missing or nothing can be read. */
export function missingGrants(caps: FlowCapabilities | null): FlowPermissionName[] {
  const p = caps?.permissions;
  if (!p || caps?.addonError) return [];
  return [...(p.microphone !== "granted" ? ["microphone" as const] : []), ...(!p.accessibility || p.postEvents === false ? ["accessibility" as const] : [])];
}

export function GrantPills({ mode, missing, refresh, tour }: { mode: Exclude<AppMode, "chat">; missing: FlowPermissionName[]; refresh: () => void; tour?: string }) {
  if (!missing.length) return null;
  const name = MODE_LABEL[mode];
  const access = isMac ? "Accessibility" : "input access";
  return (
    <div data-tour={tour} className="flex max-w-full flex-wrap items-center justify-center gap-2">
      {missing.map((what) => (
        <FixPill key={what} onClick={() => void flowBridge()?.request(what, mode === "flow" ? "flow_home" : "other").then(refresh)}
          tip={what === "microphone" ? `${name} hears you through the microphone`
            : mode === "flow" ? `Flow needs ${access} to hear its key in every app` : `Dictate needs ${access} to hear its key and type for you`}>
          {what === "microphone" ? "Allow microphone" : `Allow ${access}`}
        </FixPill>
      ))}
    </div>
  );
}
