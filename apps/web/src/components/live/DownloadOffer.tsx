"use client";

import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button, notice } from "@/components/ui";
import { aboutSize, downloadPlan, listed, planModels, WEIGHTS_WHERE, type WeightFile } from "@/lib/live/weights";
import { cn } from "@/lib/cn";

/**
 * A model download asked about where it is needed: what, how big (read from
 * the hub's listing, never the weights), where it is kept, then yes or not now.
 * Nothing downloads before the yes. The call, a voice preview and a clip to
 * transcribe all ask with it.
 */
export function DownloadOffer({ title, meanwhile, files, state, yes, onYes, onNo, className }: {
  title: string; meanwhile?: string; files: WeightFile[]; state: "ask" | "downloading" | "failed";
  yes: string; onYes: () => void; onNo: () => void; className?: string;
}) {
  const [bytes, setBytes] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void downloadPlan(files).then((p) => { if (live) setBytes(p.bytes); });
    return () => { live = false; };
  }, [files]);
  const size = aboutSize(bytes);
  // Named in full: a preview with nothing loaded yet also needs speech recognition and turn-taking.
  const what = listed(planModels({ missing: files, bytes }));
  const failed = state === "failed";

  return (
    <div role="group" aria-label={title} aria-live="polite" className={cn(notice("info"), "flex-col gap-2", className)}>
      <p className="font-medium">{failed ? "The download stopped" : title}</p>
      <p className="text-muted-strong">
        {failed ? "Check the connection and try again. Nothing half-downloaded is kept."
          : [`${what.charAt(0).toUpperCase()}${what.slice(1)}, downloaded once${size ? `, ${size}` : ""}.`, meanwhile].filter(Boolean).join(" ")}
      </p>
      {state === "ask" && <p className="text-caption text-faint">{WEIGHTS_WHERE}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" disabled={state === "downloading"} onClick={onYes}>
          {state === "downloading" ? <><Loader2 className="animate-spin" aria-hidden /> Downloading…</> : <><Download aria-hidden /> {failed ? "Try again" : yes}</>}
        </Button>
        {state !== "downloading" && <Button size="sm" variant="ghost" onClick={onNo}>Not now</Button>}
      </div>
    </div>
  );
}
