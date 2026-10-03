"use client";

import { KeyboardOff } from "lucide-react";
import { Button, Advanced } from "@/components/ui";
import { flowBridge } from "@/lib/flow/bridge";
import { addonProblem, type KeyUser } from "@/lib/flow/failure";

// The ol-input addon did not load, so the double tap goes unheard. Said in words
// with the one fix, on each home and in each mode's settings alike; the loader's
// own message (paths and all) waits behind a disclosure for whoever needs it.

export function AddonCard({ error, packaged, user, onRetry }: { error: string; packaged: boolean; user: KeyUser; onRetry: () => void }) {
  const { title, detail } = addonProblem(packaged, user);
  // The addon loads on demand, so a build is picked up without a restart. The
  // settings nudge is what makes the Flow runtime arm its key listener again.
  const retry = () => { flowBridge()?.settingsChanged?.(); onRetry(); };
  return (
    <div role="alert" className="flex w-full min-w-0 flex-col gap-2 rounded-lg bg-card p-5 text-left shadow-card">
      <div className="flex flex-wrap items-center gap-3.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-raised">
          <KeyboardOff className="size-4 text-muted-strong" aria-hidden />
        </span>
        <div className="flex min-w-[12rem] flex-1 flex-col gap-0.5">
          <span className="text-title-sm font-medium">{title}</span>
          <span className="text-label leading-relaxed text-muted-strong">{detail}</span>
        </div>
        <Button size="sm" onClick={retry}>Try again</Button>
      </div>
      <Advanced id="flow-addon-error" label="Technical details">
        <pre className="whitespace-pre-wrap break-all rounded-md bg-surface-raised px-3 py-2 font-mono text-caption text-muted-foreground">{error}</pre>
      </Advanced>
    </div>
  );
}
