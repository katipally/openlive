"use client";

import { AlertTriangle, Check, Minus, X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { FlowCapabilities } from "@/lib/flow/bridge";

// What this machine can actually do, in the person's words, with the thing to do
// about it when there is one. Everything here was read from the addon: nothing
// is inferred from the platform name, and "could not tell" is its own answer.

type Row = { label: string; state: "yes" | "no" | "unknown"; detail: string };

function rows(caps: FlowCapabilities): Row[] {
  const report = caps.report;
  const perms = caps.permissions;
  const mac = caps.platform === "darwin";

  const out: Row[] = [
    {
      label: "Typing into other apps",
      state: perms ? (perms.accessibility ? "yes" : "no") : "unknown",
      detail: perms?.accessibility
        ? `Through ${report?.injection === "type" ? "direct typing" : "the clipboard"}.`
        : mac
          ? "macOS has not given OpenLive Accessibility access. Open Privacy & Security, then Accessibility, then switch OpenLive on."
          : "The system has not allowed OpenLive to send input. Flow will still answer out loud.",
    },
    {
      label: "Hearing you",
      state: perms ? (perms.microphone === "granted" ? "yes" : "no") : "unknown",
      detail: perms?.microphone === "granted"
        ? "Open only while you hold the key."
        : perms?.microphone === "denied"
          ? "The microphone was refused. Flow cannot listen until you allow it in your system settings."
          : "Not asked for yet. Flow asks the first time you hold the key.",
    },
    {
      label: "Seeing the screen",
      state: perms ? (perms.screenRecording ? "yes" : "no") : "unknown",
      detail: perms?.screenRecording
        ? `Asked for only when you ask about what is on screen. Captured with ${report?.captureBackend || "the system capture"}.`
        : "Not granted yet. Flow asks the first time you ask it about something on screen, and works without it until then.",
    },
    {
      label: "Reading text in a picture",
      state: report ? (report.ocr ? "yes" : "no") : "unknown",
      detail: report?.ocr
        ? `Using ${report.ocrEngine || "the system text recogniser"}.`
        : "This machine has no text recogniser, so Flow can look at the screen but cannot read words out of it. It will say so rather than guess.",
    },
    {
      label: "Reading what you have selected",
      state: report ? (report.selection ? "yes" : "no") : "unknown",
      detail: report?.selection
        ? `Through ${report.selectionBackend || "the accessibility layer"}.`
        : "The apps on this machine will not hand over the selection, so ask Flow to look at the screen instead.",
    },
    {
      label: "Moving and clicking other apps",
      state: report ? (report.windowControl ? "yes" : "no") : "unknown",
      detail: report?.windowControl ? "Anything beyond reading asks you first." : "This session does not allow synthetic input.",
    },
  ];

  if (caps.wayland) {
    out.unshift({
      label: "A key that works everywhere",
      state: "no",
      detail: "This is a Wayland session, and the compositor will not hand out a system-wide key. Trigger Flow from the menu bar instead, or log in to an X11 session.",
    });
  }
  if (report && !caps.wayland) {
    out.unshift({
      label: "A key that works everywhere",
      state: report.hook ? "yes" : "no",
      detail: report.hook ? "Flow listens for its own key, in every app." : "The global key listener did not install on this machine.",
    });
  }
  if (report?.elevatedWindowInjection === false) {
    out.push({
      label: "Typing into an administrator window",
      state: "no",
      detail: "A window running with more privileges than OpenLive will swallow the text. Flow says so rather than typing into nothing.",
    });
  }
  return out;
}

export function CapabilityPanel({ caps, error, onRecheck }: { caps: FlowCapabilities | null; error: string; onRecheck: () => void }) {
  if (error || !caps) {
    return (
      <div className="flex flex-col gap-3 rounded-lg bg-card p-5 shadow-[var(--shadow-card)]">
        <p className="flex items-start gap-2 text-body leading-relaxed text-muted-strong">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive-text" aria-hidden />
          <span>{error || "OpenLive could not ask the desktop what this machine can do."}</span>
        </p>
        <button type="button" onClick={onRecheck}
          className="self-start rounded-full bg-surface-raised px-4 py-2 text-label font-medium transition hover:bg-foreground/10">
          Check now
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col rounded-lg bg-card p-1.5 shadow-[var(--shadow-card)]">
      {rows(caps).map((r, i) => (
        <div key={r.label} className={cn("flex items-start gap-3 rounded-md px-3.5 py-3", i > 0 && "shadow-[inset_0_1px_0_var(--border)]")}>
          <Mark state={r.state} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-body font-medium">{r.label}</span>
            <span className="text-label leading-relaxed text-muted-strong">{r.detail}</span>
          </div>
        </div>
      ))}
      <div className="flex items-center justify-end px-2 py-2">
        <button type="button" onClick={onRecheck}
          className="rounded-full bg-surface-raised px-3 py-1.5 text-label font-medium transition hover:bg-foreground/10">
          Check again
        </button>
      </div>
    </div>
  );
}

function Mark({ state }: { state: Row["state"] }) {
  const label = state === "yes" ? "Available" : state === "no" ? "Unavailable" : "Could not tell";
  return (
    <span role="img" aria-label={label}
      className={cn("mt-0.5 grid size-5 shrink-0 place-items-center rounded-full",
        state === "yes" ? "bg-success/15 text-success-text" : state === "no" ? "bg-destructive/10 text-destructive-text" : "bg-foreground/[0.07] text-muted-foreground")}>
      {state === "yes" ? <Check className="size-3.5" strokeWidth={2.6} /> : state === "no" ? <X className="size-3.5" strokeWidth={2.6} /> : <Minus className="size-3.5" strokeWidth={2.6} />}
    </span>
  );
}
