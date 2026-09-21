"use client";

import { useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ExternalLink, Minus, Monitor } from "lucide-react";
import type { FlowConfig } from "@openlive/flow-store";
import { gsap, useGSAP, DUR, EASE, prefersReduced } from "@/lib/gsap";
import { cn } from "@/lib/cn";
import { segBtn, segWrap } from "@/lib/seg";
import { isDesktop, isMacDesktop } from "@/lib/platform";
import { useUi } from "@/lib/uiStore";
import { OpenLiveOrb } from "@/components/OpenLiveOrb";
import { flowBridge, type FlowPermissions } from "@/lib/flow/bridge";
import { useFlowCapabilities } from "@/lib/flow/useCapabilities";
import { bindingLabel } from "@/lib/flow/binding";
import type { FlowConfigPatch } from "@/lib/flow/useFlowConfig";
import { BindingField } from "./BindingField";
import { BrainPicker } from "./BrainPicker";
import { FlowCanvas } from "./FlowCanvas";

// The first run, and only Flow's. Three screens: what Flow is, what it needs
// from the machine and which key wakes it, and who does the thinking. After the
// third there is nothing left to do but hold the key.
//
// Every screen leaves something configured rather than only explaining it, and
// nothing is a dead end: the step dots jump anywhere and "Skip setup" finishes
// from any screen. Everything finer lives in Flow's settings, which is one
// click away for the rest of the app's life.
//
// macOS never calls back when a grant is given. The capability poll runs at 1Hz
// while the setup screen is up and recovers live, so nobody is told to relaunch.

const STEPS = ["flow", "setup", "brain"] as const;
type Step = (typeof STEPS)[number];

const TITLES: Record<Step, string> = {
  flow: "What Flow is",
  setup: "Permissions and your key",
  brain: "Who does the thinking",
};

export function FlowOnboarding({ onDone, config, brainReady, save }: {
  onDone: () => void;
  config: FlowConfig | null;
  brainReady: boolean;
  save: (patch: FlowConfigPatch) => void;
}) {
  const [index, setIndex] = useState(0);
  const step = STEPS[index]!;
  const { caps, error, available, refresh } = useFlowCapabilities(step === "setup");
  const root = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    if (prefersReduced()) return;
    gsap.fromTo(".ol-onb", { autoAlpha: 0, y: 14 }, { autoAlpha: 1, y: 0, duration: DUR.base, ease: EASE.emphasized, stagger: 0.055 });
  }, { scope: root, dependencies: [index] });

  const perms = caps?.permissions ?? null;
  const mac = caps?.platform === "darwin";
  const last = index === STEPS.length - 1;

  return (
    <div ref={root} className="flex h-full min-h-0 flex-col">
      <header className={cn("flex h-14 shrink-0 items-center gap-3 pr-3",
        isMacDesktop ? "pl-[84px]" : "pl-4", isDesktop && "app-drag")}>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <OpenLiveOrb size={22} />
          <span className="truncate text-body font-semibold">Setting up Flow</span>
        </div>

        <nav aria-label="Setup steps" className="flex shrink-0 items-center gap-1.5">
          {STEPS.map((id, i) => (
            <button key={id} type="button" onClick={() => setIndex(i)}
              aria-label={`Go to ${TITLES[id]}`} aria-current={i === index ? "step" : undefined}
              className={cn("h-1.5 rounded-full transition-all duration-300 ease-out",
                i === index ? "w-8 bg-foreground" : i < index ? "w-6 bg-foreground/60" : "w-6 bg-foreground/20")} />
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
          <span className="hidden shrink-0 text-caption text-muted-foreground sm:inline">
            {`${TITLES[step]} · ${index + 1} of ${STEPS.length}`}
          </span>
          <button type="button" onClick={onDone}
            className="shrink-0 rounded-full px-3 py-1.5 text-label font-medium text-muted-strong transition hover:bg-foreground/[0.06] hover:text-foreground">
            Skip setup
          </button>
        </div>
      </header>

      <FlowCanvas className={cn(step === "flow" && "max-w-[52rem]", step === "brain" && "max-w-[56rem]")}>
        {step === "flow" && <WhatFlowIs binding={config?.binding ?? ""} />}
        {step === "setup" && (
          <Setup perms={perms} mac={mac} available={available} error={error} refresh={refresh}
            config={config} save={save} armed={!!caps?.armed && !caps?.hookError} />
        )}
        {step === "brain" && <Brain config={config} save={save} brainReady={brainReady} binding={config?.binding ?? ""} />}

        <div className="ol-onb flex flex-wrap items-center gap-x-3 gap-y-2 pt-2">
          {index > 0 && (
            <button type="button" onClick={() => setIndex(index - 1)}
              className="flex shrink-0 items-center gap-2 rounded-full px-4 py-2.5 text-callout font-medium text-muted-strong transition hover:bg-foreground/[0.06] hover:text-foreground">
              <ArrowLeft className="size-4" aria-hidden /> Back
            </button>
          )}
          <span className="flex-1" />
          <button type="button" onClick={() => (last ? onDone() : setIndex(index + 1))}
            className="group flex shrink-0 items-center gap-2 rounded-full bg-foreground px-6 py-2.5 text-callout font-medium text-background shadow-[var(--shadow-card)] transition hover:opacity-90 active:scale-[0.98]">
            {last ? "Start using Flow" : "Continue"}
            <ArrowRight className="size-4 transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden />
          </button>
        </div>
      </FlowCanvas>
    </div>
  );
}

// ── 1. what Flow is ─────────────────────────────────────────────────────────

function WhatFlowIs({ binding }: { binding: string }) {
  const key = bindingLabel(binding) || "your key";
  return (
    <>
      <div className="ol-onb flex flex-col gap-5">
        <OpenLiveOrb size={76} />
        <h1 className="text-display font-semibold tracking-tight">One key. Anywhere on the machine.</h1>
        <p className="max-w-[40rem] text-title-sm leading-relaxed text-muted-strong">
          Hold it, say what you want, let go. Flow types the words into whatever app your cursor is already in, does
          things for you when you ask, and says the rest out loud.
        </p>
      </div>

      <div className="ol-onb grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(15rem,1fr))]">
        <Beat n="1" title="Hold">{`Hold ${key} in any app. A small pill appears next to your cursor and the microphone opens.`}</Beat>
        <Beat n="2" title="Talk">Say it the way you would say it to a person. Half a sentence is fine.</Beat>
        <Beat n="3" title="Let go">Flow works out whether you wanted words, an answer, or something done.</Beat>
      </div>

      <ul className="ol-onb flex flex-col gap-3">
        <Point>
          It is one agent, not a dictation box. &ldquo;Write that as a commit message&rdquo; and &ldquo;what is this
          error&rdquo; go down the same path, and only the first one ends with text in your document.
        </Point>
        <Point>
          It can look and it can act. It reads your selection, your clipboard and, when you ask about something on
          screen, the screen. It can click and type in other apps for you.
        </Point>
        <Point>
          Nothing to open first. No workspace, no project folder, no window. Flow is armed for as long as OpenLive is
          running, including when this window is closed.
        </Point>
      </ul>

      <div className="ol-onb flex flex-col gap-3 rounded-lg bg-surface-raised p-5">
        <span className="text-micro font-medium uppercase tracking-[0.06em] text-muted-foreground">What Flow never does</span>
        <Never>It never listens to the keyboard. It watches one key going down and coming up, and nothing else.</Never>
        <Never>It never holds the microphone between turns. There is no wake word. Let go and the microphone closes.</Never>
        <Never>No audio is kept. What you said is written down as text on this machine, and the recording is gone.</Never>
        <Never>Nothing leaves this machine except what the brain you pick needs in order to answer you.</Never>
      </div>

      <p className="ol-onb text-label leading-relaxed text-muted-strong">
        Two screens left: what Flow needs from this machine and which key wakes it, then who does the thinking.
      </p>
    </>
  );
}

const Beat = ({ n, title, children }: { n: string; title: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-2 rounded-lg bg-card p-5 shadow-[var(--shadow-card)]">
    <span className="grid size-7 place-items-center rounded-full bg-surface-raised font-mono text-label text-muted-strong">{n}</span>
    <span className="text-title-sm font-semibold">{title}</span>
    <p className="text-body leading-relaxed text-muted-strong">{children}</p>
  </div>
);

// ── 2. permissions and the key ──────────────────────────────────────────────

/** Newer builds report the right to post events apart from the right to read
 *  the accessibility tree. Read what is there rather than assuming one boolean:
 *  when only the combined grant exists there is one card, and when both exist
 *  each one is granted, explained and fixed on its own. */
const postEventsSplit = (perms: FlowPermissions | null): boolean | null =>
  perms && typeof perms.postEvents === "boolean" ? perms.postEvents : null;

const ACTIVATION = [
  { id: "hold_or_toggle", label: "Hold to talk" },
  { id: "toggle", label: "Tap to toggle" },
  { id: "ptt", label: "Push to talk" },
] as const;

function Setup({ perms, mac, available, error, refresh, config, save, armed }: {
  perms: FlowPermissions | null;
  mac: boolean;
  available: boolean;
  error: string;
  refresh: () => void;
  config: FlowConfig | null;
  save: (patch: FlowConfigPatch) => void;
  armed: boolean;
}) {
  const posting = postEventsSplit(perms);
  const openSystemSettings = { label: "Open System Settings", icon: true, run: () => void flowBridge()?.init().then(refresh) };
  const ms = config?.holdThresholdMs ?? 250;

  return (
    <>
      <div className="ol-onb flex flex-col gap-3">
        <h1 className="text-title-lg font-semibold tracking-tight">What Flow needs, and which key wakes it.</h1>
        <p className="max-w-[40rem] text-title-sm leading-relaxed text-muted-strong">
          Flow asks for the fewest permissions it can, as late as it can. Every one of them can be taken back, and Flow
          keeps working with less.
        </p>
      </div>

      {!available && (
        <Card className="ol-onb">
          <p className="text-body leading-relaxed text-muted-strong">
            Flow needs the OpenLive desktop app: a browser tab cannot hold a key down for the whole machine.
          </p>
        </Card>
      )}

      <div className="ol-onb flex flex-col gap-3.5">
        <PermissionCard
          title="Microphone"
          granted={perms?.microphone === "granted"}
          active={perms?.microphone !== "granted"}
          detail={perms?.microphone === "granted"
            ? "Granted. Open only while you hold the key."
            : perms?.microphone === "denied"
              ? "Refused. Allow OpenLive the microphone in your system settings, and this picks it up on its own."
              : "So Flow can hear you. There is no wake word, and it never listens between turns."}
          action={perms?.microphone === "granted" ? null : {
            label: "Allow the microphone",
            run: () => void flowBridge()?.request("microphone").then(refresh),
          }}
        />

        <PermissionCard
          title={mac ? "Accessibility" : "Input access"}
          granted={!!perms?.accessibility}
          active={!perms?.accessibility}
          detail={perms?.accessibility
            ? posting === null
              ? "Granted. This is how Flow types and clicks for you."
              : "Granted. This is how Flow reads where your cursor is and what is on screen."
            : "This is the one that makes the key work at all. Waiting for you in System Settings, checking every second."}
          note={perms?.accessibility ? "" : mac
            ? "Privacy & Security, then Accessibility, then switch OpenLive on. This window picks it up on its own, no restart."
            : "Allow OpenLive to send input. This window picks it up on its own, no restart."}
          action={perms?.accessibility ? null : openSystemSettings}
          secondary={perms?.accessibility ? null : { label: "Check now", run: refresh }}
        />

        {posting !== null && (
          <PermissionCard
            title="Posting keys and clicks"
            granted={posting}
            active={!posting}
            detail={posting
              ? "Granted. This is the one that actually types the words and presses the buttons."
              : "Not granted. Flow can still hear you and answer out loud, but nothing will land in your apps."}
            note={posting ? "" : "Separate from reading the screen, so you can let Flow look without letting it touch."}
            action={posting ? null : openSystemSettings}
            secondary={posting ? null : { label: "Check now", run: refresh }}
          />
        )}

        <Card>
          <div className="flex flex-wrap items-center gap-3.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-raised">
              <Monitor className="size-4 text-muted-strong" aria-hidden />
            </span>
            <div className="flex min-w-[12rem] flex-1 flex-col gap-0.5">
              <span className="text-title-sm font-medium">
                Screen Recording <span className="text-label font-normal text-muted-foreground">optional, later</span>
              </span>
              <span className="text-label leading-relaxed text-muted-strong">
                Not asked for now. Flow asks the first time you ask it about something on your screen, and never before
                that.
              </span>
            </div>
          </div>
        </Card>

        {error && <p className="text-label leading-relaxed text-destructive-text">{error}</p>}
      </div>

      <div className="ol-onb flex flex-col gap-3 pt-2">
        <div className="flex flex-col gap-1">
          <h2 className="text-title-sm font-semibold">Your key</h2>
          <p className="max-w-[40rem] text-label leading-relaxed text-muted-strong">
            One key that belongs to Flow everywhere on this machine. Pick one you never press on purpose.
          </p>
        </div>
        {config
          ? <BindingField binding={config.binding} onSave={(binding) => save({ binding })} />
          : <p className="text-body text-muted-strong">Reading your settings&hellip;</p>}
      </div>

      <div className="ol-onb flex flex-col gap-3">
        <div className={segWrap + " self-start"} role="group" aria-label="How the key opens Flow">
          {ACTIVATION.map((o) => (
            <button key={o.id} type="button" onClick={() => save({ activation: o.id })}
              aria-pressed={config?.activation === o.id} className={segBtn(config?.activation === o.id)}>
              {o.label}
            </button>
          ))}
        </div>
        <p className="max-w-[40rem] text-label leading-relaxed text-muted-strong">
          Hold to talk keeps the microphone open while the key is down and closes it when you let go, and a tap toggles
          it open for a long thought. Push to talk is the same without the toggle.
        </p>
      </div>

      <Card className="ol-onb">
        <div className="flex flex-col gap-2">
          <span className="text-title-sm font-medium">{`Held alone for ${ms} milliseconds`}</span>
          <p className="text-body leading-relaxed text-muted-strong">
            {`Anything quicker stays an ordinary modifier, and holding it together with any other key never opens Flow. `}
            That is why Control+C is still Control+C, and why a key you already use as a modifier is safe to pick.
          </p>
        </div>
      </Card>

      <p className="ol-onb flex items-center gap-2 text-label text-muted-strong">
        <span className={cn("size-1.5 shrink-0 rounded-full transition-colors", armed ? "bg-success" : "bg-muted-foreground")} aria-hidden />
        {armed
          ? "The key is live right now, in every app on this machine."
          : "The key is not armed yet. It arms itself the moment the permissions above are in place."}
      </p>
    </>
  );
}

// ── 3. the brain ────────────────────────────────────────────────────────────

function Brain({ config, save, brainReady, binding }: {
  config: FlowConfig | null;
  save: (patch: FlowConfigPatch) => void;
  brainReady: boolean;
  binding: string;
}) {
  const openSettingsTab = useUi((s) => s.openSettingsTab);
  const key = bindingLabel(binding) || "your key";
  return (
    <>
      <div className="ol-onb flex flex-col gap-3">
        <h1 className="text-title-lg font-semibold tracking-tight">Who does the thinking?</h1>
        <p className="max-w-[40rem] text-title-sm leading-relaxed text-muted-strong">
          Flow is the voice and the hands. The brain behind it is yours to pick, and you can swap it any time without
          losing your settings. Either one gets exactly the same tools.
        </p>
      </div>

      <div className="ol-onb">
        <BrainPicker config={config} save={save} />
      </div>

      {!brainReady && (
        <Card className="ol-onb" active>
          <div className="flex flex-col gap-3">
            <span className="text-title-sm font-medium">Nothing is configured yet</span>
            <p className="text-body leading-relaxed text-muted-strong">
              Neither a provider key nor a signed-in coding agent was found, so Flow has nothing to think with. It will
              still hear you and still say so, rather than failing quietly.
            </p>
            <button type="button" onClick={() => openSettingsTab("models")}
              className="self-start rounded-full bg-accent px-4 py-2.5 text-callout font-medium text-accent-foreground transition hover:opacity-90">
              Add a provider key
            </button>
          </div>
        </Card>
      )}

      <div className="ol-onb flex flex-wrap items-center gap-5 rounded-xl bg-card p-6 shadow-[var(--shadow-card)]">
        <OpenLiveOrb size={64} pulse />
        <div className="flex min-w-[14rem] flex-1 flex-col gap-1.5">
          <span className="text-title-sm font-medium">That is everything.</span>
          <p className="text-body leading-relaxed text-muted-strong">
            {`Hold ${key} anywhere and say something. Try “what can you do”, or put your cursor in a text field and say “write me a one-line summary of what Flow is”.`}
          </p>
        </div>
        <span className="flex min-w-[4.5rem] shrink-0 items-center justify-center rounded-lg bg-surface-raised px-4 py-2.5 font-mono text-title-sm shadow-[inset_0_-2px_0_rgba(0,0,0,.08)]">
          {key}
        </span>
      </div>

      <p className="ol-onb text-label leading-relaxed text-muted-strong">
        How it speaks, what it may do without asking, and how it types are all in Flow&rsquo;s settings, behind the gear
        in the corner. Every one of them has a sensible default already.
      </p>
    </>
  );
}

// ── shared pieces ───────────────────────────────────────────────────────────

const Card = ({ children, active, className }: { children: React.ReactNode; active?: boolean; className?: string }) => (
  <div className={cn("rounded-lg bg-card p-5 shadow-[var(--shadow-card)] transition-shadow duration-300",
    active && "shadow-[var(--shadow-pop),inset_0_0_0_2px_var(--accent-soft)]", className)}>
    {children}
  </div>
);

const Point = ({ children }: { children: React.ReactNode }) => (
  <li className="flex items-start gap-3">
    <Check className="mt-0.5 size-4 shrink-0 text-success-text" strokeWidth={2.4} aria-hidden />
    <span className="text-callout leading-relaxed">{children}</span>
  </li>
);

const Never = ({ children }: { children: React.ReactNode }) => (
  <p className="flex items-start gap-3">
    <Minus className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={2.4} aria-hidden />
    <span className="text-body leading-relaxed text-muted-strong">{children}</span>
  </p>
);

function PermissionCard({ title, granted, detail, note, action, secondary, active }: {
  title: string;
  granted: boolean;
  detail: string;
  note?: string;
  active?: boolean;
  action: { label: string; run: () => void; icon?: boolean } | null;
  secondary?: { label: string; run: () => void } | null;
}) {
  return (
    <Card active={active && !granted}>
      <div className="flex flex-col gap-3.5">
        <div className="flex flex-wrap items-center gap-3.5">
          <span className={cn("grid size-9 shrink-0 place-items-center rounded-full transition-colors duration-300",
            granted ? "bg-success/15" : "bg-arc-soft")}>
            {granted
              ? <Check className="size-4 text-success-text" strokeWidth={2.6} aria-hidden />
              : <span className="size-2.5 animate-pulse rounded-full bg-arc" aria-hidden />}
          </span>
          <div className="flex min-w-[12rem] flex-1 flex-col gap-0.5">
            <span className="text-title-sm font-medium">{title}</span>
            <span className="text-label leading-relaxed text-muted-strong">{detail}</span>
          </div>
        </div>
        {note && (
          <p className="rounded-md bg-surface-raised px-3.5 py-3 text-label leading-relaxed text-muted-strong">{note}</p>
        )}
        {(action || secondary) && (
          <div className="flex flex-wrap items-center gap-2.5">
            {action && (
              <button type="button" onClick={action.run}
                className="flex items-center gap-2 rounded-full bg-accent px-4 py-2.5 text-callout font-medium text-accent-foreground shadow-[var(--shadow-xs)] transition hover:opacity-90 active:scale-[0.98]">
                {action.icon && <ExternalLink className="size-4" aria-hidden />} {action.label}
              </button>
            )}
            {secondary && (
              <button type="button" onClick={secondary.run}
                className="rounded-full bg-surface-raised px-4 py-2.5 text-callout font-medium transition hover:bg-foreground/10 active:scale-[0.98]">
                {secondary.label}
              </button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
