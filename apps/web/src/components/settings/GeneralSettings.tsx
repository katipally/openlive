"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Monitor, Sun, Moon, Keyboard } from "lucide-react";
import { voiceInputMode, setVoiceInputMode, type VoiceInputMode } from "@/lib/live/usePtt";
import { isDesktop, savedMiniHotkey, saveMiniHotkey } from "@/lib/platform";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { Section } from "./Section";

const THEMES = [
  { id: "system", label: "System", icon: Monitor },
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
] as const;

const segWrap = "inline-flex rounded-lg bg-card p-1 shadow-[var(--shadow-card)]";
const segBtn = (on: boolean) => cn("flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-[12.5px] font-medium transition",
  on ? "bg-foreground text-background shadow-sm" : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground");

function ThemePicker() {
  const { theme, setTheme } = useTheme();
  // next-themes resolves on the client only — avoid a hydration mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const active = mounted ? theme ?? "system" : "system";
  return (
    <div className={segWrap}>
      {THEMES.map((t) => (
        <button key={t.id} onClick={() => setTheme(t.id)} className={segBtn(active === t.id)}>
          <t.icon className="size-3.5" /> {t.label}
        </button>
      ))}
    </div>
  );
}

type Desk = {
  loginItem?: (v?: boolean) => Promise<boolean>;
  setMiniHotkey?: (acc: string) => Promise<{ ok: boolean; hotkey: string }>;
};
const desk = (): Desk => (typeof window !== "undefined" ? ((window as unknown as { openlive?: Desk }).openlive ?? {}) : {});

function LoginItemToggle() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => { void desk().loginItem?.().then(setOn).catch(() => setOn(null)); }, []);
  if (on === null) return null;
  const flip = () => { const next = !on; setOn(next); void desk().loginItem?.(next); };
  return (
    <label className="flex cursor-pointer select-none items-center gap-2.5 text-[12.5px] text-foreground">
      <button role="switch" aria-checked={on} onClick={flip}
        className={cn("relative h-5 w-9 rounded-full transition", on ? "bg-accent" : "bg-foreground/15")}>
        <span className={cn("absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left]", on ? "left-[18px]" : "left-0.5")} />
      </button>
      Open OpenLive at login
    </label>
  );
}

/** Capture-a-shortcut field for the global mini-mode talk hotkey. */
function MiniHotkeyField() {
  const [hotkey, setHotkey] = useState(savedMiniHotkey);
  const [recording, setRecording] = useState(false);

  const onKey = async (e: React.KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    if (e.key === "Escape") { setRecording(false); return; }
    const mods = [e.metaKey && "CommandOrControl", e.ctrlKey && !e.metaKey && "Control", e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean) as string[];
    const key = e.code === "Space" ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : /^F\d{1,2}$/.test(e.key) ? e.key : "";
    if (!key || !mods.length) return; // need modifier + key (a bare letter would swallow typing everywhere)
    const acc = [...mods, key].join("+");
    setRecording(false);
    const res = await desk().setMiniHotkey?.(acc).catch(() => null);
    if (res && !res.ok) { toast(`That shortcut is taken — keeping ${res.hotkey}.`); setHotkey(res.hotkey); return; }
    setHotkey(acc);
    saveMiniHotkey(acc);
  };

  return (
    <div className="flex items-center gap-2">
      <button onClick={() => setRecording(true)} onKeyDown={onKey} onBlur={() => setRecording(false)}
        className={cn("flex h-9 items-center gap-2 rounded-lg px-3 font-mono text-[12.5px] transition",
          recording ? "bg-accent/10 text-accent shadow-[inset_0_0_0_1.5px_var(--accent)]" : "bg-card text-foreground shadow-[var(--shadow-card)] hover:shadow-[var(--shadow-pop)]")}>
        <Keyboard className="size-4" /> {recording ? "Press a shortcut…" : hotkey}
      </button>
      <span className="text-[11px] text-faint">Toggles talking from any app while in mini mode.</span>
    </div>
  );
}

function VoiceInputPicker() {
  const [mode, setMode] = useState<VoiceInputMode>("hold");
  useEffect(() => setMode(voiceInputMode()), []);
  const pick = (m: VoiceInputMode) => { setMode(m); setVoiceInputMode(m); };
  return (
    <div className={segWrap}>
      <button onClick={() => pick("hold")} className={segBtn(mode === "hold")}>Hold to talk</button>
      <button onClick={() => pick("toggle")} className={segBtn(mode === "toggle")}>Tap to toggle</button>
    </div>
  );
}

export function GeneralSettings() {
  return (
    <div className="flex flex-col gap-7">
      <Section title="Appearance" desc="Match your system, or force light or dark. Applies everywhere, instantly.">
        <ThemePicker />
      </Section>

      <Section title="Voice input" desc="How Space behaves once you turn push-to-talk on during a call (the keyboard button next to the mic): hold it down like a walkie-talkie, or tap once to start and again to stop. Off by default — normally OpenLive just listens hands-free.">
        <VoiceInputPicker />
      </Section>

      {isDesktop && (
        <Section title="Mini mode" desc="The floating pill's global talk shortcut — it works even while another app has focus.">
          <MiniHotkeyField />
        </Section>
      )}

      {isDesktop && (
        <Section title="Startup" desc="Have OpenLive ready the moment you sit down.">
          <LoginItemToggle />
        </Section>
      )}
    </div>
  );
}
