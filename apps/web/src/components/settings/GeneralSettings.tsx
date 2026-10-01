"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { Monitor, Sun, Moon, Keyboard } from "lucide-react";
import { api } from "@/lib/api";
import { useUi } from "@/lib/uiStore";
import { desktopPlatform, isDesktop } from "@/lib/platform";
import { toast } from "@/lib/toast";
import { Switch, Button, ListGroup, ListRow, Segmented, type SegOption, Textarea } from "@/components/ui";
import { GLASS_REASON, setLook, useAppearance, type Look } from "@/lib/look";
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
    <ListRow label="Look" detail={a.look === "glass" ? "See-through to your desktop" : "Solid surfaces"}>
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
    <ListGroup>
      <ListRow asLabel label="Open at login" detail="Starts in the background when you log in, so Flow is ready without opening a window.">
        <Switch on={on} onFlip={flip} />
      </ListRow>
    </ListGroup>
  );
}

function EndOnLockToggle() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => { void desk().endOnLock?.().then(setOn).catch(() => setOn(null)); }, []);
  if (on === null) return null;
  const flip = () => { const next = !on; setOn(next); void desk().endOnLock?.(next).then(setOn).catch(() => setOn(!next)); };
  return (
    <ListGroup>
      <ListRow asLabel label="End Flow and calls when the screen locks" detail="Flow closes and a call ends on lock. Sleep always ends them. Turn this off to keep going while the screen is locked. Flow keeps listening then and can still act on this computer.">
        <Switch on={on} onFlip={flip} />
      </ListRow>
    </ListGroup>
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
      <Textarea value={value} onChange={(e) => onChange(e.target.value)} rows={4}
        placeholder={'e.g. "Keep answers to one sentence unless I ask for detail. Call me Yash. Casual tone."'} />
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
      <Section id="set-general-appearance" title="Appearance" desc="One look for the whole app, in light or dark. Applies everywhere, instantly.">
        <ListGroup>
          <LookRow />
          <ListRow label="Theme"><ThemePicker /></ListRow>
        </ListGroup>
      </Section>

      <Section id="set-general-style" title="Your assistant's style" desc="How should it behave and speak? Your own words, passed to whoever you're talking to, API mode and coding agents alike.">
        <CustomInstructions />
      </Section>

      <Section id="set-general-shortcuts" title="Keyboard shortcuts" desc="Every shortcut in one sheet. Press ? anywhere.">
        <Button size="sm" onClick={() => openShortcuts(true)}>
          <Keyboard /> View all
        </Button>
      </Section>

      {isDesktop && (
        <Section id="set-general-startup" title="Startup" desc="Have OpenLive ready the moment you sit down.">
          <LoginItemToggle />
        </Section>
      )}

      {isDesktop && (desktopPlatform === "darwin" || desktopPlatform === "win32") && (
        <Section id="set-general-lock" title="Screen lock" desc="Whether Flow and calls keep going while your screen is locked.">
          <EndOnLockToggle />
        </Section>
      )}
    </div>
  );
}
