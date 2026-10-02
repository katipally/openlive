"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Languages, Settings2, Sparkles, WholeWord } from "lucide-react";
import type { DictateTone, Dictation, FlowConfig } from "@openlive/flow-store";
import { Button, Chip, Keycaps, Segmented, Switch, Tooltip, groupLabel, linkClass, pill } from "@/components/ui";
import { OpenLiveOrb } from "@/components/OpenLiveOrb";
import { SwitchHole } from "@/components/flow/FlowShell";
import { AddonCard } from "@/components/flow/AddonCard";
import { historyQuery } from "@/components/settings/DictateHistory";
import { useFlowConfig } from "@/lib/flow/useFlowConfig";
import { useFlowCapabilities } from "@/lib/flow/useCapabilities";
import { flowBridge, type FlowPermissionName } from "@/lib/flow/bridge";
import { hotkeyKeys } from "@/lib/dictate/hotkey";
import { countWords } from "@/lib/dictate/cleanup";
import { CURATED_LANGUAGES, loadPipelineConfig, onPipelineConfig } from "@/lib/live/pipelineConfig";
import { clock, dayLabel } from "@/lib/flow/format";
import { desktopPlatform, isDesktop, isMac, isMacDesktop } from "@/lib/platform";
import { useUi } from "@/lib/uiStore";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";

// Dictate's half of the window: whether it is on and how to use it, the few
// choices people change day to day, and what was said last. Everything finer
// is in Settings > Dictate, one press away.

const RECENT = 5;
const TONES: { id: DictateTone; label: string }[] = [{ id: "natural", label: "Natural" }, { id: "casual", label: "Casual" }, { id: "formal", label: "Formal" }];
const WORDS_AT = { anchor: "set-dictate-dictionary", reveal: "set-dictate-words" };
const HISTORY_AT = { anchor: "set-dictate-history-list", reveal: "set-dictate-history" };

export function DictateHome() {
  const { config, save } = useFlowConfig();
  const { caps, refresh } = useFlowCapabilities();
  const settingsOpen = useUi((s) => s.settingsOpen);
  const openSettingsTab = useUi((s) => s.openSettingsTab);

  // A grant given in System Settings announces nothing; coming back to the window re-reads it.
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  const own = config?.dictate;
  const on = !!own?.enabled;
  const perms = caps?.permissions;
  const missing: FlowPermissionName[] = perms && !caps?.addonError
    ? [...(perms.microphone !== "granted" ? ["microphone" as const] : []), ...(!perms.accessibility ? ["accessibility" as const] : [])]
    : [];

  return (
    <div className="flex h-dvh flex-col">
      <header className={cn("relative flex h-14 shrink-0 items-center gap-3 pr-3", isMacDesktop ? "pl-traffic-lights" : "pl-4", isDesktop && "app-drag")}>
        {isDesktop && <SwitchHole />}
      </header>

      {/* Anchored to the top like Flow's home, so the list changing height never moves the controls. */}
      <div className="openlive-scroll flex min-h-0 flex-1 flex-col overflow-y-auto animate-fade-in">
        <div className="mx-auto flex w-full max-w-[37.5rem] flex-1 flex-col gap-11 px-6 pb-8 pt-[clamp(1rem,6dvh,4rem)]">
          <section className="flex shrink-0 flex-col items-center gap-5 text-center">
            <OpenLiveOrb size={84} pulse={on} paused={settingsOpen || !on} />
            <div className="flex max-w-full flex-col items-center gap-2">
              <h1 className="text-display font-semibold tracking-tight">Dictate</h1>
              <Hint own={own} />
            </div>

            <label className={cn("flex min-h-control-lg max-w-full cursor-pointer items-center gap-3 rounded-full border border-border bg-secondary py-1.5 pl-4 pr-2 shadow-rim transition hover:border-border-heavy",
              !config && "pointer-events-none opacity-60")}>
              <span className="min-w-0 break-words text-body font-medium">{on ? "Dictate is on" : "Dictate is off"}</span>
              <Switch on={on} onFlip={() => save({ dictate: { enabled: !on } })} />
            </label>

            {on && missing.length > 0 && (
              <div className="flex max-w-full flex-wrap items-center justify-center gap-2">
                {missing.map((what) => (
                  <PillButton key={what} tip={what === "microphone" ? "Dictate hears you through the microphone" : `Dictate needs ${isMac ? "Accessibility" : "input access"} to hear its key and type for you`}
                    onClick={() => void flowBridge()?.request(what, "other").then(refresh)}>
                    <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-arc" />
                    <span className="min-w-0 truncate">{what === "microphone" ? "Allow microphone" : isMac ? "Allow Accessibility" : "Allow input access"}</span>
                  </PillButton>
                ))}
              </div>
            )}
            {caps?.addonError && <AddonCard error={caps.addonError} packaged={caps.packaged} onRetry={refresh} />}

            {own && <QuickPills own={own} save={(patch) => save({ dictate: patch })} off={!on} />}
          </section>

          <Recent own={own} />

          <button type="button" onClick={() => openSettingsTab("dictate")} className={cn(linkClass, "self-center text-label")}>More settings</button>
        </div>
      </div>
    </div>
  );
}

/** How to use it, with the person's own keys, or why nothing happens. */
function Hint({ own }: { own: FlowConfig["dictate"] | undefined }) {
  if (!own) return <p className="text-callout text-muted-foreground">&hellip;</p>;
  if (!own.enabled) return <p className="max-w-sm text-callout leading-relaxed text-muted-foreground">Talk instead of type, in any app. Turn it on to start.</p>;
  const hold = hotkeyKeys(own.hotkey, desktopPlatform);
  const command = hotkeyKeys(own.commandHotkey, desktopPlatform);
  return (
    <>
      <p className="flex max-w-full flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-callout leading-relaxed text-muted-foreground">
        Hold <Keycaps keys={hold} label={hold.join(" ")} /> to talk. Double-tap for hands-free.
      </p>
      <p className="flex max-w-full flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-label text-faint">
        Select text and hold <Keycaps keys={command} label={command.join(" ")} /> to change it by voice.
      </p>
    </>
  );
}

/** The choices people change from day to day. Each one is the same setting Settings > Dictate shows. */
function QuickPills({ own, save, off }: { own: FlowConfig["dictate"]; save: (patch: Partial<FlowConfig["dictate"]>) => void; off: boolean }) {
  const openSettingsTab = useUi((s) => s.openSettingsTab);
  const [language, setLanguage] = useState(() => loadPipelineConfig().language);
  useEffect(() => onPipelineConfig((c) => setLanguage(c.language)), []);
  const languageName = CURATED_LANGUAGES.find((l) => l.code === language)?.name ?? language;
  const polish = own.polish;
  const words = own.words.length;

  return (
    <div className={cn("flex max-w-full flex-col items-center gap-3", off && "opacity-60")}>
      <div className="flex max-w-full flex-wrap items-center justify-center gap-2">
        <PillButton tip={polish.enabled ? "AI polish rewrites what you said in your tone" : "Turn on AI polish to rewrite in a tone"} pressed={polish.enabled}
          onClick={() => save({ polish: { ...polish, enabled: !polish.enabled } })}>
          <Sparkles aria-hidden />
          <span className="min-w-0 truncate">{polish.enabled ? "AI polish on" : "AI polish off"}</span>
        </PillButton>
        <PillButton tip="Language, in Settings > Voice" onClick={() => openSettingsTab("voice", { anchor: "set-voice-language" })}>
          <Languages aria-hidden />
          <span className="min-w-0 truncate">{languageName}</span>
        </PillButton>
        <PillButton tip="Your dictionary, in Settings > Dictate" onClick={() => openSettingsTab("dictate", WORDS_AT)}>
          <WholeWord aria-hidden />
          <span className="min-w-0 truncate">{words === 1 ? "1 word" : `${words} words`}</span>
        </PillButton>
        <PillButton tip="Dictate settings" onClick={() => openSettingsTab("dictate")} className="aspect-square justify-center px-0">
          <Settings2 aria-hidden /><span className="sr-only">Dictate settings</span>
        </PillButton>
      </div>
      <Tooltip label={!polish.enabled && "Tone applies with AI polish on"} className="flex max-w-full">
        <Segmented label="Tone" size="sm" value={polish.tone} disabled={!polish.enabled} wrap
          onChange={(tone) => save({ polish: { ...polish, tone } })} options={TONES} />
      </Tooltip>
    </div>
  );
}

/** The last few dictations, newest first. */
function Recent({ own }: { own: FlowConfig["dictate"] | undefined }) {
  const openSettingsTab = useUi((s) => s.openSettingsTab);
  const { data, error } = useQuery({ ...historyQuery, retry: 1, refetchOnWindowFocus: true });
  const items = data?.items ?? [];
  const hold = own ? hotkeyKeys(own.hotkey, desktopPlatform) : [];

  return (
    <section className="flex min-h-0 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 pb-2">
        <h2 className={cn("min-w-0 flex-1", groupLabel)}>Recent</h2>
        {items.length > 0 && <Button variant="ghost" size="sm" onClick={() => openSettingsTab("dictate", HISTORY_AT)}>See all</Button>}
      </div>
      {error && <Empty>Dictate&rsquo;s history could not be read.</Empty>}
      {!error && data && !items.length && (
        <Empty>
          {own?.history === "off"
            ? "History is off, so dictations are not kept."
            : <>Nothing yet. Click into any text box, hold <Keycaps keys={hold} label={hold.join(" ")} className="align-middle" /> and say something.</>}
        </Empty>
      )}
      {items.slice(0, RECENT).map((d) => <Row key={d.id} d={d} />)}
    </section>
  );
}

function Row({ d }: { d: Dictation }) {
  const iso = new Date(d.at).toISOString();
  const day = dayLabel(iso);
  const copy = () => void navigator.clipboard.writeText(d.final).then(() => toast("Copied", "info")).catch(() => toast("That could not be copied."));
  const words = countWords(d.final);
  return (
    <div className="group flex min-w-0 items-start gap-3 rounded-lg py-2 pl-3 pr-1.5 transition hover:bg-foreground/[0.06]">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Tooltip label={d.final} truncated className="flex min-w-0 max-w-full">
          <span className="line-clamp-2 whitespace-pre-line break-words text-body text-foreground">{d.final}</span>
        </Tooltip>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">
          <span className="tabular-nums">{day === "Today" ? clock(iso) : `${day}, ${clock(iso)}`}</span>
          {d.app && <span className="break-words">{d.app}</span>}
          {d.command ? <Chip>Command</Chip> : <span>{words === 1 ? "1 word" : `${words} words`}</span>}
        </span>
      </span>
      <Tooltip label="Copy" className="shrink-0">
        <Button variant="ghost" size="sm" icon onClick={copy} aria-label="Copy"
          className="opacity-60 group-hover:opacity-100 focus-visible:opacity-100"><Copy /></Button>
      </Tooltip>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="m-auto max-w-[32rem] break-words px-6 py-10 text-center text-body leading-relaxed text-muted-strong">{children}</p>;
}

/** A capsule you press, the kit's pill, as Flow's home draws its status row. */
function PillButton({ onClick, tip, pressed, className, children }: { onClick: () => void; tip: string; pressed?: boolean; className?: string; children: React.ReactNode }) {
  return (
    <Tooltip label={tip} className="min-w-0 max-w-full">
      <button type="button" onClick={onClick} aria-pressed={pressed} className={cn(pill, "min-w-0 max-w-full", pressed && "border-transparent bg-accent-soft text-link-foreground", className)}>
        {children}
      </button>
    </Tooltip>
  );
}
