"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { Monitor, Sun, Moon, Keyboard } from "lucide-react";
import { api } from "@/lib/api";
import { useUi } from "@/lib/uiStore";
import { voiceInputMode, setVoiceInputMode, type VoiceInputMode } from "@/lib/live/usePtt";
import { isDesktop } from "@/lib/platform";
import { toast } from "@/lib/toast";
import { Switch } from "@/components/Switch";
import { Segmented, type SegOption } from "@/lib/seg";
import { Section } from "./Section";

const THEMES = [
  { id: "system", label: "System", icon: Monitor },
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
] as const;

function ThemePicker() {
  const { theme, setTheme } = useTheme();
  // next-themes resolves on the client only — avoid a hydration mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const active = mounted ? theme ?? "system" : "system";
  return <Segmented label="Theme" options={THEMES} value={active as (typeof THEMES)[number]["id"]} onChange={setTheme} />;
}

type Desk = {
  loginItem?: (v?: boolean) => Promise<boolean>;
};
const desk = (): Desk => (typeof window !== "undefined" ? ((window as unknown as { openlive?: Desk }).openlive ?? {}) : {});

function LoginItemToggle() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => { void desk().loginItem?.().then(setOn).catch(() => setOn(null)); }, []);
  if (on === null) return null;
  // Settle on what the OS reports back: it can refuse (macOS approval, a policy).
  const flip = () => { const next = !on; setOn(next); void desk().loginItem?.(next).then(setOn).catch(() => setOn(!next)); };
  return (
    <label className="flex cursor-pointer select-none items-start gap-2.5">
      <Switch on={on} onFlip={flip} className="mt-0.5" />
      <span className="text-label leading-snug text-foreground">
        Open at login
        <span className="block text-caption text-faint">Starts in the background when you log in, so Flow is ready without opening a window.</span>
      </span>
    </label>
  );
}

const VOICE_INPUTS: SegOption<VoiceInputMode>[] = [{ id: "hold", label: "Hold to talk" }, { id: "toggle", label: "Tap to toggle" }];

function VoiceInputPicker() {
  const [mode, setMode] = useState<VoiceInputMode>("hold");
  useEffect(() => setMode(voiceInputMode()), []);
  const pick = (m: VoiceInputMode) => { setMode(m); setVoiceInputMode(m); };
  return <Segmented label="Voice input" options={VOICE_INPUTS} value={mode} onChange={pick} />;
}

/** Spoken progress for coding-agent turns — a short voiced one-liner ("Step 2 of
 *  4 — refactor the store.") when a tool has run a while and the agent is quiet. */
function NarrateToggle() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  // On unless explicitly "0" — mirrors narrationEnabled() on the server, so the
  // switch always shows what the session will actually do.
  const on = (data as Record<string, string> | undefined)?.narrateProgress !== "0";
  const flip = () => void api.updateSettings({ narrateProgress: on ? "0" : "1" })
    .then(() => qc.invalidateQueries({ queryKey: ["settings"] }))
    .catch(() => toast("Couldn’t save that setting. Try again."));
  return (
    <label className="flex cursor-pointer select-none items-start gap-2.5">
      <Switch on={on} onFlip={flip} className="mt-0.5" />
      <span className="text-label leading-snug text-foreground">
        Narrate agent progress
        <span className="block text-caption text-faint">While a coding agent works in silence, speak its plan steps out loud (&ldquo;Step 2 of 4 — …&rdquo;). At most a few short lines a turn.</span>
      </span>
    </label>
  );
}

/** Free-text custom instructions, injected into the built-in assistant's system
 *  prompt AND every coding agent's session preamble. Debounced save. */
function CustomInstructions() {
  const { data } = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const value = text ?? (data as Record<string, string> | undefined)?.customInstructions ?? "";

  const onChange = (v: string) => {
    setText(v.slice(0, 2000));
    setSaved(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void api.updateSettings({ customInstructions: v.slice(0, 2000) })
        .then(() => { setSaved(true); setTimeout(() => setSaved(false), 1500); })
        .catch(() => toast("Couldn’t save your instructions. Keep typing to try again."));
    }, 600);
  };

  return (
    <div className="flex w-full max-w-xl flex-col gap-1.5">
      <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={4}
        placeholder={'e.g. "Keep answers to one sentence unless I ask for detail. Call me Yash. Casual tone."'}
        className="w-full resize-y rounded-lg bg-card p-3 text-body leading-relaxed text-foreground shadow-[var(--shadow-card)] outline-none transition placeholder:text-faint focus:shadow-[var(--shadow-pop)]" />
      <div className="flex items-center justify-between text-caption text-faint">
        <span>Applies from the next call, to API mode and every coding agent.</span>
        <span>{saved ? "Saved" : `${value.length}/2000`}</span>
      </div>
    </div>
  );
}

export function GeneralSettings() {
  const openShortcuts = useUi((s) => s.setShortcutsOpen);
  return (
    <div className="flex flex-col gap-7">
      <Section id="set-general-appearance" title="Appearance" desc="Match your system, or force light or dark. Applies everywhere, instantly.">
        <ThemePicker />
      </Section>

      <Section id="set-general-style" title="Your assistant's style" desc="How should it behave and speak? Your own words, passed to whoever you're talking to — API mode and coding agents alike.">
        <CustomInstructions />
      </Section>

      <Section id="set-general-speech" title="Voice & speech" desc="How you talk to OpenLive and how it talks back. Push-to-talk (once enabled during a call): hold Space like a walkie-talkie, or tap to toggle — off by default, normally it just listens hands-free.">
        <div className="flex flex-col gap-4">
          <VoiceInputPicker />
          <NarrateToggle />
        </div>
      </Section>

      <Section id="set-general-shortcuts" title="Keyboard shortcuts" desc="Every shortcut in one sheet. Press ? anywhere.">
        <button type="button" onClick={() => openShortcuts(true)}
          className="flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-label font-medium text-muted-foreground transition hover:border-border-heavy hover:text-foreground">
          <Keyboard className="size-3.5" /> View all
        </button>
      </Section>

      {isDesktop && (
        <Section id="set-general-startup" title="Startup" desc="Have OpenLive ready the moment you sit down.">
          <LoginItemToggle />
        </Section>
      )}
    </div>
  );
}
