"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { Monitor, Sun, Moon, Keyboard } from "lucide-react";
import { api } from "@/lib/api";
import { useUi } from "@/lib/uiStore";
import { desktopPlatform, isDesktop } from "@/lib/platform";
import { toast } from "@/lib/toast";
import type { InsertionMethod } from "@openlive/flow-store";
import { Switch, Button, ListGroup, ListRow, Segmented, type SegOption, Textarea, Advanced, Slider } from "@/components/ui";
import { GLASS_REASON, setLook, useAppearance, type Look } from "@/lib/look";
import { useFlowConfig } from "@/lib/flow/useFlowConfig";
import { cn } from "@/lib/cn";
import { Section } from "./Section";
import { OneLine, QueryState } from "./common";

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

/** Glass or Flat for the whole app. Only the desktop app has a desktop to show
 *  through, so the row is absent in a browser. */
function LookRow() {
  const a = useAppearance();
  if (!a) return null;
  const options: SegOption<Look>[] = [
    { id: "glass", label: "Glass", unavailable: a.support.reason ? GLASS_REASON[a.support.reason] : undefined },
    { id: "flat", label: "Flat" },
  ];
  return (
    <ListRow label="Look" detail={a.look === "glass" ? "See-through to your desktop" : "Solid surfaces"} info="Glass needs a window that can blur what is behind it. Without one, it falls back to Flat.">
      <Segmented label="Look" options={options} value={a.look} onChange={setLook} />
    </ListRow>
  );
}

type Desk = {
  loginItem?: (v?: boolean) => Promise<boolean>;
  endOnLock?: (v?: boolean) => Promise<boolean>;
};
const desk = (): Desk => (typeof window !== "undefined" ? ((window as unknown as { openlive?: Desk }).openlive ?? {}) : {});

function LoginItemToggle() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => { void desk().loginItem?.().then(setOn).catch(() => setOn(null)); }, []);
  if (on === null) return null;
  // Settle on what the OS reports back: it can refuse (macOS approval, a policy).
  const flip = () => { const next = !on; setOn(next); void desk().loginItem?.(next).then(setOn).catch(() => setOn(!next)); };
  return (
    <ListRow asLabel label="Open at login" detail="Starts in the background" info="Starts in the background when you log in, so Flow is ready without opening a window.">
      <Switch on={on} onFlip={flip} />
    </ListRow>
  );
}

function EndOnLockToggle() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => { void desk().endOnLock?.().then(setOn).catch(() => setOn(null)); }, []);
  if (on === null) return null;
  const flip = () => { const next = !on; setOn(next); void desk().endOnLock?.(next).then(setOn).catch(() => setOn(!next)); };
  return (
    <div id="set-general-lock">
      <ListRow asLabel label="End Flow and calls when the screen locks" detail="Sleep always ends them"
        info="Flow closes and a call ends on lock. Turn this off to keep going while the screen is locked. Flow keeps listening then and can still act on this computer.">
        <Switch on={on} onFlip={flip} />
      </ListRow>
    </div>
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
    <div className="flex w-full flex-col gap-1.5">
      <Textarea value={value} onChange={(e) => onChange(e.target.value)} rows={4}
        placeholder={'e.g. "Keep answers to one sentence unless I ask for detail. Call me Yash. Casual tone."'} />
      <div className="flex items-center gap-3 text-caption text-faint">
        <OneLine text="Applies from the next call, to API models and coding agents alike." className="flex-1" />
        <span className="ml-auto shrink-0 tabular-nums">{saved ? "Saved" : `${value.length} / 2000`}</span>
      </div>
    </div>
  );
}

const METHODS: SegOption<InsertionMethod>[] = [{ id: "paste", label: "Paste" }, { id: "type", label: "Type it out" }];

/** How Flow and Dictate put text where the cursor is. Stored in Flow's config,
 *  whose `insertion` keys the input addon reads on every paste. */
function TypingAtCursor() {
  const { config, save, error, saving, loading, refetch } = useFlowConfig();
  if (!config) return <QueryState loading={loading} error={error || null} retrying={false} onRetry={refetch} what="read the typing settings" />;
  const { insertion } = config;
  return (
    <div className="flex flex-col gap-2">
      <ListGroup>
        <ListRow label="How text goes in" info="Paste is instant. Type it out works in apps that block paste.">
          <Segmented label="How text goes in" value={insertion.method} options={METHODS} onChange={(method) => save({ insertion: { method } })} />
        </ListRow>
        <div id="set-general-clipboard">
          <ListRow label="Put my clipboard back" detail={insertion.restoreClipboard ? "After every paste" : "Pasted text stays on it"} asLabel
            info="A paste goes through the clipboard. On, what you had copied comes back right after. Off, what Flow or Dictate typed stays there to paste again.">
            <Switch on={insertion.restoreClipboard} onFlip={() => save({ insertion: { restoreClipboard: !insertion.restoreClipboard } })} />
          </ListRow>
        </div>
        <Advanced id="flow:typing" label="Advanced timing" className="py-1">
          <div className={cn("flex flex-col gap-3", insertion.method !== "paste" && "opacity-60")}>
            <Slider label="Hold the modifier for" min={0} max={300} step={10} value={insertion.modifierHoldMs} commitOnRelease saving={saving}
              format={(v) => `${v} ms`} onChange={(modifierHoldMs) => save({ insertion: { modifierHoldMs } })} />
            <Slider label="Wait before putting the clipboard back" min={0} max={1000} step={25} value={insertion.clipboardQuietMs} commitOnRelease saving={saving}
              format={(v) => `${v} ms`} onChange={(clipboardQuietMs) => save({ insertion: { clipboardQuietMs } })} />
            <Slider label="Give up waiting after" min={1000} max={20_000} step={500} value={insertion.clipboardTimeoutMs} commitOnRelease saving={saving}
              format={(v) => `${(v / 1000).toFixed(1)} s`} onChange={(clipboardTimeoutMs) => save({ insertion: { clipboardTimeoutMs } })} />
          </div>
        </Advanced>
      </ListGroup>
      {error && <p className="text-label text-destructive-text">{error}</p>}
    </div>
  );
}

export function GeneralSettings() {
  const openShortcuts = useUi((s) => s.setShortcutsOpen);
  return (
    <div className="flex flex-col gap-7">
      <Section id="set-general-appearance" title="Appearance" desc="Applies everywhere, instantly.">
        <ListGroup>
          <ListRow label="Theme"><ThemePicker /></ListRow>
          <LookRow />
        </ListGroup>
      </Section>

      {isDesktop && (
        <Section id="set-general-startup" title="Startup" desc="Ready when you sit down.">
          <ListGroup className="empty:hidden">
            <LoginItemToggle />
            {(desktopPlatform === "darwin" || desktopPlatform === "win32") && <EndOnLockToggle />}
          </ListGroup>
        </Section>
      )}

      <Section id="set-general-typing" title="Typing at cursor" desc="How Flow and Dictate put text in other apps.">
        <TypingAtCursor />
      </Section>

      <Section id="set-general-style" title="Assistant style" desc="Your words, passed to whoever answers.">
        <CustomInstructions />
      </Section>

      <Section id="set-general-shortcuts" title="Keyboard shortcuts" desc="Every shortcut in one sheet.">
        <ListGroup>
          <ListRow label="All shortcuts" detail="Press ? anywhere">
            <Button size="sm" onClick={() => openShortcuts(true)}><Keyboard /> Open sheet</Button>
          </ListRow>
        </ListGroup>
      </Section>
    </div>
  );
}
