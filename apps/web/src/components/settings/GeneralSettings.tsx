"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { Monitor, Sun, Moon, Keyboard } from "lucide-react";
import { api } from "@/lib/api";
import { voiceInputMode, setVoiceInputMode, type VoiceInputMode } from "@/lib/live/usePtt";
import { loadPipelineConfig, savePipelineConfig } from "@/lib/live/pipelineConfig";
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

/** Speaking speed for all TTS engines — stored in the pipeline config (same
 *  store Pipeline → Text-to-speech reads); applies from the next reply. */
function SpeakingSpeed() {
  const [cfg, setCfg] = useState(() => loadPipelineConfig());
  const set = (v: number) => setCfg(savePipelineConfig({ ...cfg, tts: { ...cfg.tts, speed: v } }));
  return (
    <label className="flex max-w-md flex-col gap-1.5">
      <span className="flex items-center justify-between text-[12.5px] text-foreground">Speaking speed<span className="tabular-nums text-muted-foreground">{cfg.tts.speed.toFixed(2)}×</span></span>
      <input type="range" min={0.5} max={2} step={0.05} value={cfg.tts.speed} onChange={(e) => set(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-border accent-foreground" />
    </label>
  );
}

/** Spoken progress for coding-agent turns — a short voiced one-liner ("Step 2 of
 *  4 — refactor the store.") when a tool has run a while and the agent is quiet. */
function NarrateToggle() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const on = (data as Record<string, string> | undefined)?.narrateProgress === "1";
  const flip = () => void api.updateSettings({ narrateProgress: on ? "" : "1" }).then(() => qc.invalidateQueries({ queryKey: ["settings"] }));
  return (
    <label className="flex cursor-pointer select-none items-start gap-2.5">
      <button role="switch" aria-checked={on} onClick={flip}
        className={cn("relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition", on ? "bg-accent" : "bg-foreground/15")}>
        <span className={cn("absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left]", on ? "left-[18px]" : "left-0.5")} />
      </button>
      <span className="text-[12.5px] leading-snug text-foreground">
        Narrate agent progress
        <span className="block text-[11px] text-faint">While a coding agent works in silence, speak its plan steps out loud (&ldquo;Step 2 of 4 — …&rdquo;). At most a few short lines a turn.</span>
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
      void api.updateSettings({ customInstructions: v.slice(0, 2000) }).then(() => { setSaved(true); setTimeout(() => setSaved(false), 1500); });
    }, 600);
  };

  return (
    <div className="flex w-full max-w-xl flex-col gap-1.5">
      <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={4}
        placeholder={'e.g. "Keep answers to one sentence unless I ask for detail. Call me Yash. Casual tone."'}
        className="w-full resize-y rounded-lg bg-card p-3 text-[13px] leading-relaxed text-foreground shadow-[var(--shadow-card)] outline-none transition placeholder:text-faint focus:shadow-[var(--shadow-pop)]" />
      <div className="flex items-center justify-between text-[11px] text-faint">
        <span>Applies from the next call — to the built-in assistant and every coding agent.</span>
        <span>{saved ? "Saved" : `${value.length}/2000`}</span>
      </div>
    </div>
  );
}

export function GeneralSettings() {
  return (
    <div className="flex flex-col gap-7">
      <Section title="Appearance" desc="Match your system, or force light or dark. Applies everywhere, instantly.">
        <ThemePicker />
      </Section>

      <Section title="Your assistant's style" desc="How should it behave and speak? Your own words, passed to whoever you're talking to — the built-in assistant and coding agents alike.">
        <CustomInstructions />
      </Section>

      <Section title="Voice & speech" desc="How you talk to OpenLive and how it talks back. Push-to-talk (once enabled during a call): hold Space like a walkie-talkie, or tap to toggle — off by default, normally it just listens hands-free.">
        <div className="flex flex-col gap-4">
          <VoiceInputPicker />
          <SpeakingSpeed />
          <NarrateToggle />
        </div>
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
