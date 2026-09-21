"use client";

import { useEffect, useRef, useState } from "react";
import { Lock } from "lucide-react";
import { cn } from "@/lib/cn";
import { savedMiniHotkey } from "@/lib/platform";
import { flowBridge } from "@/lib/flow/bridge";
import { bindingFromEvent, bindingLabel, isModifierOnly } from "@/lib/flow/binding";

// Recording a binding, with modifier-only support, which is the whole point:
// holding Control alone IS the trigger, so the field has to treat "nothing but
// modifiers are down" as a finished answer rather than as an unfinished chord.
//
// Two refusals are real and both are shown rather than swallowed. The addon
// refuses to record while macOS secure input is active, because only
// FlagsChanged survives it and a keyed binding would silently capture just the
// modifier. And the addon is the authority on whether a string is a binding at
// all, so every candidate goes through it before it is offered as savable.

/** Accelerators are `+`-joined too, but in Electron's vocabulary. */
const miniHotkeyParts = (): string[] =>
  savedMiniHotkey().toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);

/** The mini-mode talk hotkey is the one other global key OpenLive itself holds. */
function conflictWith(binding: string): string {
  if (!binding) return "";
  const mine = new Set(binding.split("+").map((p) => p.split("_")[0]));
  const theirs = miniHotkeyParts().map((p) =>
    p === "commandorcontrol" || p === "cmdorctrl" ? "command" : p === "alt" ? "option" : p === "control" ? "ctrl" : p === "super" || p === "meta" ? "command" : p);
  const key = binding.split("+").find((p) => !["ctrl", "option", "shift", "command", "fn"].includes(p.split("_")[0] ?? ""));
  // Only a real collision: the same non-modifier key under the same modifiers.
  if (!key || !theirs.includes(key)) return "";
  const mods = theirs.filter((t) => t !== key);
  return mods.every((m) => mine.has(m)) ? `This is also OpenLive's mini-mode talk shortcut (${savedMiniHotkey()}).` : "";
}

export function BindingField({ binding, onSave }: { binding: string; onSave: (canonical: string) => void }) {
  const [recording, setRecording] = useState(false);
  const [held, setHeld] = useState("");
  const [refusal, setRefusal] = useState("");
  const [invalid, setInvalid] = useState("");
  const box = useRef<HTMLButtonElement>(null);
  // Set the moment a candidate is captured, so the key-up that ends the hold
  // saves what was held rather than racing React's state.
  const candidate = useRef("");

  const stop = () => { setRecording(false); setHeld(""); candidate.current = ""; };

  const start = async () => {
    setInvalid("");
    const why = await flowBridge()?.recordingRefusal();
    const reason = why?.ok ? why.value : why ? why.error : null;
    if (reason) { setRefusal(reason); return; }
    setRefusal("");
    setRecording(true);
    candidate.current = "";
  };

  const commit = async (raw: string) => {
    const api = flowBridge();
    if (!api) { stop(); return; }
    const parsed = await api.parseBinding(raw);
    if (!parsed.ok) { setInvalid(parsed.error); stop(); return; }
    stop();
    onSave(parsed.value.canonical);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    if (e.key === "Escape") { stop(); return; }
    const next = bindingFromEvent(e);
    if (!next) return;
    candidate.current = next;
    setHeld(next);
    // A real key finishes the chord there and then; modifiers wait for the release.
    if (!isModifierOnly(next)) void commit(next);
  };

  const onKeyUp = (e: React.KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    const pending = candidate.current;
    if (pending && isModifierOnly(pending)) void commit(pending);
  };

  // Secure input can come on while the field is open, and the recording it would
  // capture would be a lie. Watching it is cheaper than explaining it afterwards.
  useEffect(() => {
    if (!recording) return;
    flowBridge()?.onSecureInput((s) => {
      if (!s.active) return;
      setRefusal(s.culprit
        ? `${s.culprit} has secure input on, so key presses are hidden from every app including this one.`
        : "Secure input is on, so key presses are hidden from every app including this one.");
      stop();
    });
  }, [recording]);

  const shown = recording ? held || binding : binding;
  const conflict = conflictWith(binding);

  return (
    <div className="flex flex-col gap-3">
      <button ref={box} type="button" onClick={start} onKeyDown={onKeyDown} onKeyUp={onKeyUp} onBlur={stop}
        aria-label={recording ? "Recording a new binding" : `Change the binding, currently ${bindingLabel(binding)}`}
        className={cn("flex min-h-[5.75rem] w-full flex-wrap items-center justify-center gap-4 rounded-lg px-4 py-4 text-left transition",
          recording ? "bg-surface-raised shadow-[0_0_0_2px_var(--accent)]" : "bg-surface-raised hover:bg-foreground/[0.05]")}>
        <span className={cn("flex min-h-11 shrink-0 items-center justify-center rounded-lg px-4 font-mono text-title",
          recording ? "bg-accent text-accent-foreground" : "bg-card text-foreground shadow-[var(--shadow-xs)]")}>
          {bindingLabel(shown)}
        </span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-body font-medium">
            {recording ? (held ? `Holding ${bindingLabel(held)}` : "Press the key you want") : "Hold this to talk"}
          </span>
          <span className="text-caption leading-relaxed text-muted-strong">
            {recording
              ? "Let go to save it, or press another key to combine. Escape cancels."
              : "Click, then hold the key you want. One modifier on its own is a perfectly good binding."}
          </span>
        </span>
      </button>

      {refusal && (
        <p className="flex items-start gap-2 text-label leading-relaxed text-destructive-text">
          <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{refusal} Leave the password field and try again.</span>
        </p>
      )}
      {invalid && <p className="text-label leading-relaxed text-destructive-text">{invalid}</p>}
      {conflict && <p className="text-label leading-relaxed text-arc">{conflict}</p>}
    </div>
  );
}
