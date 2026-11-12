"use client";

import { useState } from "react";
import { Copy, KeyboardOff } from "lucide-react";
import { Button } from "@/components/ui";
import { flowBridge } from "@/lib/flow/bridge";
import { CLI_TOGGLE_EXAMPLES, inputFix, type InputAccess } from "@/lib/flow/failure";
import { toast } from "@/lib/toast";

// Linux only: the key listener cannot read /dev/input. Said with the exact fix,
// a copy for the command (OpenLive never runs sudo), and a Check again that
// reads the devices anew and starts the listener when they open. A shortcut in
// the desktop that runs the app with a flag needs none of it, so that is said too.

export function InputAccessFix({ access, onRetry }: { access: InputAccess | null | undefined; onRetry: () => void }) {
  const [checking, setChecking] = useState(false);
  const fix = inputFix(access);
  if (!fix) return null;
  const copy = () => {
    void navigator.clipboard.writeText(fix.command!)
      .then(() => toast("Command copied. Paste it into a terminal."))
      .catch(() => toast(fix.command!));
  };
  const check = async () => {
    setChecking(true);
    await flowBridge()?.recheckInput?.();
    flowBridge()?.settingsChanged?.();
    setChecking(false);
    onRetry();
  };
  return (
    <div role="alert" className="flex w-full min-w-0 flex-col gap-3 rounded-lg bg-card p-5 text-left shadow-card">
      <div className="flex flex-wrap items-center gap-3.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-raised">
          <KeyboardOff className="size-4 text-muted-strong" aria-hidden />
        </span>
        <div className="flex min-w-[12rem] flex-1 flex-col gap-0.5">
          <span className="text-title-sm font-medium">{fix.title}</span>
          <span className="text-label leading-relaxed text-muted-strong">{fix.detail}</span>
        </div>
        <Button size="sm" onClick={() => void check()} disabled={checking}>Check again</Button>
      </div>
      {fix.command && (
        <div className="flex min-w-0 items-center gap-2 rounded-md bg-surface-raised py-1.5 pl-3 pr-1.5">
          <code className="min-w-0 flex-1 break-all font-mono text-caption">{fix.command}</code>
          <Button size="sm" variant="ghost" onClick={copy}><Copy aria-hidden /> Copy</Button>
        </div>
      )}
      <div className="flex min-w-0 flex-col gap-1.5 text-label leading-relaxed text-muted-strong">
        <span>Or skip the keys: bind a shortcut in your desktop to <code className="font-mono text-caption">openlive --toggle-dictate</code> or <code className="font-mono text-caption">openlive --toggle-flow</code>.</span>
        {CLI_TOGGLE_EXAMPLES.map((e) => (
          <span key={e.desktop} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span>{e.desktop}</span>
            <code className="min-w-0 break-all font-mono text-caption">{e.command}</code>
          </span>
        ))}
      </div>
    </div>
  );
}
