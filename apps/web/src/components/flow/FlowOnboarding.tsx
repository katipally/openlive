"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ExternalLink, Minus, Monitor } from "lucide-react";
import type { FlowConfig, RiskAction, RiskTier } from "@openlive/flow-store";
import { gsap, useGSAP, DUR, EASE, prefersReduced } from "@/lib/gsap";
import { cn } from "@/lib/cn";
import { segBtn, segWrap } from "@/lib/seg";
import { isDesktop, isMacDesktop } from "@/lib/platform";
import { useUi } from "@/lib/uiStore";
import { OpenLiveOrb } from "@/components/OpenLiveOrb";
import { flowBridge, type FlowPermissions } from "@/lib/flow/bridge";
import { useFlowCapabilities } from "@/lib/flow/useCapabilities";
import { bindingLabel } from "@/lib/flow/binding";
import { useFlowSessions, sessionLine } from "@/lib/flow/sessions";
import type { FlowConfigPatch } from "@/lib/flow/useFlowConfig";
import { BindingField } from "./BindingField";
import { BrainPicker } from "./BrainPicker";
import { FlowCanvas } from "./FlowCanvas";

// The first run. Seven short screens, one per thing a person has to know before
// Flow is useful: what it is, what it is allowed to do, which key, who thinks,
// what it may do on its own, how it answers, and then actually doing it once.
//
// The order is the order of consequence, and every screen leaves something
// configured rather than only explaining it. Nothing is a dead end: the step
// dots jump anywhere, and "Skip setup" finishes from any screen.
//
// macOS never calls back when a grant is given. The capability poll runs at 1Hz
// while the permissions screen is up and recovers live, so nobody is ever told
// to relaunch.

const STEPS = ["flow", "permissions", "trigger", "brain", "safety", "voice", "try"] as const;
type Step = (typeof STEPS)[number];

/** The trigger cannot be watched from this window: the hook's effects only ever
 *  reach the owner renderer. The store is the shared truth, so the last step
 *  watches it for a turn that was not there when the screen opened. */
const TRY_POLL_MS = 1500;

export function FlowOnboarding({ onDone, config, brainReady, save }: {
  onDone: () => void;
  config: FlowConfig | null;
  brainReady: boolean;
  save: (patch: FlowConfigPatch) => void;
}) {
  const [index, setIndex] = useState(0);
  const step = STEPS[index]!;
  const { caps, error, available, refresh } = useFlowCapabilities(step === "permissions");
  const root = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    if (prefersReduced()) return;
    gsap.fromTo(".ol-onb", { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0, duration: DUR.base, ease: EASE.out, stagger: 0.05 });
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
              aria-label={`Go to step ${i + 1} of ${STEPS.length}`} aria-current={i === index ? "step" : undefined}
              className={cn("h-1.5 w-6 rounded-full transition", i <= index ? "bg-foreground" : "bg-foreground/20")} />
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
          <span className="hidden shrink-0 font-mono text-caption tabular-nums text-muted-foreground sm:inline">
            Step {index + 1} of {STEPS.length}
          </span>
          <button type="button" onClick={onDone}
            className="shrink-0 rounded-full px-3 py-1.5 text-label font-medium text-muted-strong transition hover:bg-foreground/[0.06] hover:text-foreground">
            Skip setup
          </button>
        </div>
      </header>

      <FlowCanvas className={cn(step === "flow" && "max-w-[52rem]", step === "brain" && "max-w-[56rem]")}>
        {step === "flow" && <WhatFlowIs />}
        {step === "permissions" && (
          <Permissions perms={perms} mac={mac} available={available} error={error} refresh={refresh} />
        )}
        {step === "trigger" && <Trigger config={config} save={save} armed={!!caps?.armed && !caps?.hookError} />}
        {step === "brain" && <Brain config={config} save={save} brainReady={brainReady} />}
        {step === "safety" && <Safety config={config} />}
        {step === "voice" && <Voice config={config} save={save} />}
        {step === "try" && (
          <TryIt config={config} brainReady={brainReady} perms={perms} onGoTo={(id) => setIndex(STEPS.indexOf(id))} />
        )}

        <div className="ol-onb flex flex-wrap items-center gap-x-3 gap-y-2 pt-2">
          {index > 0 && (
            <button type="button" onClick={() => setIndex(index - 1)}
              className="flex shrink-0 items-center gap-2 rounded-full px-4 py-2.5 text-callout font-medium text-muted-strong transition hover:bg-foreground/[0.06] hover:text-foreground">
              <ArrowLeft className="size-4" aria-hidden /> Back
            </button>
          )}
          <span className="flex-1" />
          <button type="button" onClick={() => (last ? onDone() : setIndex(index + 1))}
            className="flex shrink-0 items-center gap-2 rounded-full bg-foreground px-6 py-2.5 text-callout font-medium text-background transition hover:opacity-90">
            {last ? "Start using Flow" : "Continue"} <ArrowRight className="size-4" aria-hidden />
          </button>
        </div>
      </FlowCanvas>
    </div>
  );
}

// ── 1. what Flow is ─────────────────────────────────────────────────────────

function WhatFlowIs() {
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

      <ul className="ol-onb flex flex-col gap-3">
        <Point>Nothing to open first. No workspace, no project folder, no setup.</Point>
        <Point>
          It is one agent, not a dictation box. &ldquo;Write that as a commit message&rdquo; and &ldquo;what is this
          error&rdquo; go down the same path.
        </Point>
        <Point>A small pill appears next to your cursor and goes away again. That is the whole interface.</Point>
      </ul>

      <div className="ol-onb grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(16rem,1fr))]">
        <Card className="flex flex-col gap-1.5">
          <span className="text-title-sm font-semibold">Chat</span>
          <p className="text-body leading-relaxed text-muted-strong">
            A call in this window. You pick a project folder, it sees your files, and you watch it work.
          </p>
        </Card>
        <Card className="flex flex-col gap-1.5">
          <span className="text-title-sm font-semibold">Flow</span>
          <p className="text-body leading-relaxed text-muted-strong">
            No window and no folder. It works on whatever is already in front of you, in any app.
          </p>
        </Card>
      </div>

      <p className="ol-onb text-label leading-relaxed text-muted-strong">
        They sit behind the one switch at the top of the window, on the same keys, the same agents and the same rules.
        Chat when the work is a project. Flow when the work is wherever you already are.
      </p>
    </>
  );
}

// ── 2. permissions ──────────────────────────────────────────────────────────

/** Newer builds report the right to post events apart from the right to read
 *  the accessibility tree. Read what is there rather than assuming one boolean:
 *  when only the combined grant exists there is one card, and when both exist
 *  each one is granted, explained and fixed on its own. */
const postEventsSplit = (perms: FlowPermissions | null): boolean | null =>
  perms && typeof perms.postEvents === "boolean" ? perms.postEvents : null;

function Permissions({ perms, mac, available, error, refresh }: {
  perms: FlowPermissions | null;
  mac: boolean;
  available: boolean;
  error: string;
  refresh: () => void;
}) {
  const posting = postEventsSplit(perms);
  const openSystemSettings = { label: "Open System Settings", icon: true, run: () => void flowBridge()?.init().then(refresh) };

  return (
    <>
      <div className="ol-onb flex flex-col gap-3">
        <h1 className="text-title-lg font-semibold tracking-tight">What Flow is allowed to do, and why.</h1>
        <p className="max-w-[40rem] text-title-sm leading-relaxed text-muted-strong">
          Flow asks for the fewest it can, as late as it can. Every one of them can be taken back, and Flow keeps
          working with less.
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
            : "Waiting for you in System Settings. Checking every second."}
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

      <div className="ol-onb flex flex-col gap-3 rounded-lg bg-surface-raised p-5">
        <span className="text-micro font-medium uppercase tracking-[0.06em] text-muted-foreground">What Flow never does</span>
        <Never>It never listens to the keyboard. It watches one key going down and coming up, and nothing else.</Never>
        <Never>It never holds the microphone between turns. Let go of the key and the microphone closes.</Never>
        <Never>No audio is kept. What you said is written down as text on this machine, and the recording is gone.</Never>
      </div>
    </>
  );
}

// ── 3. the trigger ──────────────────────────────────────────────────────────

const ACTIVATION = [
  { id: "hold_or_toggle", label: "Hold to talk" },
  { id: "toggle", label: "Tap to toggle" },
  { id: "ptt", label: "Push to talk" },
] as const;

function Trigger({ config, save, armed }: {
  config: FlowConfig | null;
  save: (patch: FlowConfigPatch) => void;
  armed: boolean;
}) {
  const ms = config?.holdThresholdMs ?? 250;
  return (
    <>
      <div className="ol-onb flex flex-col gap-3">
        <h1 className="text-title-lg font-semibold tracking-tight">Your key.</h1>
        <p className="max-w-[40rem] text-title-sm leading-relaxed text-muted-strong">
          One key that belongs to Flow everywhere on this machine. Pick one you never press on purpose.
        </p>
      </div>

      <div className="ol-onb">
        {config
          ? <BindingField binding={config.binding} onSave={(binding) => save({ binding })} />
          : <p className="text-body text-muted-strong">Reading your settings&hellip;</p>}
      </div>

      <div className="ol-onb flex flex-col gap-3">
        <span className="text-micro font-medium uppercase tracking-[0.06em] text-muted-foreground">Hold, or tap</span>
        <div className={segWrap + " self-start"} role="group" aria-label="How the key opens Flow">
          {ACTIVATION.map((o) => (
            <button key={o.id} type="button" onClick={() => save({ activation: o.id })}
              aria-pressed={config?.activation === o.id} className={segBtn(config?.activation === o.id)}>
              {o.label}
            </button>
          ))}
        </div>
        <p className="max-w-[40rem] text-label leading-relaxed text-muted-strong">
          Hold to talk keeps the microphone open while the key is down and closes it when you let go. Tap to toggle
          opens it on one press and closes it on the next, which is the one to use for a long thought. Push to talk is
          hold to talk without the toggle.
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
        <span className={cn("size-1.5 shrink-0 rounded-full", armed ? "bg-success" : "bg-muted-foreground")} aria-hidden />
        {armed
          ? "The key is live right now. The last step is a real go at it."
          : "The key is not armed yet. It arms itself the moment the permissions above are in place."}
      </p>
    </>
  );
}

// ── 4. the brain ────────────────────────────────────────────────────────────

function Brain({ config, save, brainReady }: {
  config: FlowConfig | null;
  save: (patch: FlowConfigPatch) => void;
  brainReady: boolean;
}) {
  const openSettingsTab = useUi((s) => s.openSettingsTab);
  return (
    <>
      <div className="ol-onb flex flex-col gap-3">
        <h1 className="text-title-lg font-semibold tracking-tight">Who does the thinking?</h1>
        <p className="max-w-[40rem] text-title-sm leading-relaxed text-muted-strong">
          Flow is the voice and the hands. The brain behind it is yours to pick, and you can swap it any time without
          losing your settings.
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
    </>
  );
}

// ── 5. safety ───────────────────────────────────────────────────────────────

const TIERS: { id: RiskTier; label: string; dot: string; detail: string }[] = [
  { id: "read", label: "Reading", dot: "bg-success", detail: "Reads the screen, your selection and your clipboard, and answers." },
  { id: "insert", label: "Typing", dot: "bg-success", detail: "Puts words where your cursor is, and on your clipboard." },
  { id: "control", label: "Hands on", dot: "bg-arc", detail: "Clicking and driving another app for you." },
  { id: "destructive", label: "Destructive", dot: "bg-destructive-fill", detail: "Deletes, resets, sends. Always asks, no exceptions." },
];

const ACTION_WORDS: Record<RiskAction, string> = {
  auto: "Happens straight away",
  ask: "Asks you first",
  deny: "Never happens",
};

function Safety({ config }: { config: FlowConfig | null }) {
  return (
    <>
      <div className="ol-onb flex flex-col gap-3">
        <h1 className="text-title-lg font-semibold tracking-tight">What it may do on its own.</h1>
        <p className="max-w-[40rem] text-title-sm leading-relaxed text-muted-strong">
          Safe things happen straight away. Anything that touches another app asks you first, on the pill, before it
          happens. Anything destructive always asks, whatever you set.
        </p>
      </div>

      <div className="ol-onb flex flex-col gap-3 rounded-lg bg-card p-5 shadow-[var(--shadow-card)]">
        {TIERS.map((t) => (
          <div key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className={cn("size-[7px] shrink-0 rounded-full", t.dot)} aria-hidden />
            <span className="w-[6.5rem] shrink-0 text-body font-medium">{t.label}</span>
            <span className="min-w-[12rem] flex-1 text-label leading-relaxed text-muted-strong">{t.detail}</span>
            <span className="shrink-0 text-label font-medium">
              {t.id === "destructive" ? "Always asks" : config ? ACTION_WORDS[config.risk[t.id]] : ""}
            </span>
          </div>
        ))}
      </div>

      <div className="ol-onb flex flex-col gap-2.5 rounded-lg bg-surface-raised p-5">
        <span className="text-title-sm font-medium">Every turn is written down</span>
        <p className="text-body leading-relaxed text-muted-strong">
          What you said, what Flow said back, every tool it called and what came back from it. The log is a file on this
          machine, and Flow&rsquo;s history reads it. Nothing leaves this machine except what your brain of choice needs
          to answer you.
        </p>
      </div>

      <p className="ol-onb text-label leading-relaxed text-muted-strong">
        You can change any of this, per tier or per tool, in Flow&rsquo;s settings.
      </p>
    </>
  );
}

// ── 6. voice ────────────────────────────────────────────────────────────────

function Voice({ config, save }: { config: FlowConfig | null; save: (patch: FlowConfigPatch) => void }) {
  return (
    <>
      <div className="ol-onb flex flex-col gap-3">
        <h1 className="text-title-lg font-semibold tracking-tight">It talks back.</h1>
        <p className="max-w-[40rem] text-title-sm leading-relaxed text-muted-strong">
          Flow says its replies out loud, so you never have to look at a window to hear the answer.
        </p>
      </div>

      <div className="ol-onb flex flex-col gap-4 rounded-lg bg-card p-5 shadow-[var(--shadow-card)]">
        <Toggle
          on={config?.voice.speakReplies !== false}
          onFlip={(speakReplies) => save({ voice: { speakReplies } })}
          label="Say replies out loud"
          note="With this off, every reply is written on the pill instead."
        />
        <Toggle
          on={config?.voice.bargeIn !== false}
          onFlip={(bargeIn) => save({ voice: { bargeIn } })}
          label="Let me talk over it"
          note="Start talking and Flow stops mid-sentence. Only what it actually said out loud is kept."
        />
      </div>

      <div className="ol-onb flex flex-col gap-2.5 rounded-lg bg-surface-raised p-5">
        <span className="text-title-sm font-medium">It goes quiet by itself</span>
        <p className="text-body leading-relaxed text-muted-strong">
          When a meeting app is in front, when another app has the microphone, and when Do Not Disturb is on. The reply
          is written on the pill for that turn instead, and nothing is lost. The speaker button on the pill overrides
          all of it, in both directions, for the rest of the session.
        </p>
      </div>
    </>
  );
}

// ── 7. the first real turn ──────────────────────────────────────────────────

function TryIt({ config, brainReady, perms, onGoTo }: {
  config: FlowConfig | null;
  brainReady: boolean;
  perms: FlowPermissions | null;
  onGoTo: (step: Step) => void;
}) {
  const binding = bindingLabel(config?.binding ?? "");
  const missing = whatIsMissing(perms, brainReady);
  const { data } = useFlowSessions("", 1, missing ? 0 : TRY_POLL_MS);
  const latest = data?.sessions[0] ?? null;
  const stamp = latest ? `${latest.id}:${latest.updatedAt}` : "none";

  // What the store already held when this screen opened. Anything newer than
  // that is the turn they just took, which is the only honest way to say so.
  const [before, setBefore] = useState<string | null>(null);
  useEffect(() => { if (before === null && data) setBefore(stamp); }, [before, data, stamp]);
  const heard = before !== null && stamp !== "none" && stamp !== before;

  if (missing) {
    return (
      <>
        <div className="ol-onb flex flex-col gap-3">
          <h1 className="text-title-lg font-semibold tracking-tight">One thing is still missing.</h1>
          <p className="max-w-[40rem] text-title-sm leading-relaxed text-muted-strong">{missing.detail}</p>
        </div>
        <Card className="ol-onb" active>
          <div className="flex flex-col gap-3">
            <span className="text-title-sm font-medium">{missing.title}</span>
            <button type="button" onClick={() => onGoTo(missing.step)}
              className="self-start rounded-full bg-accent px-4 py-2.5 text-callout font-medium text-accent-foreground transition hover:opacity-90">
              {missing.action}
            </button>
          </div>
        </Card>
        <p className="ol-onb text-label leading-relaxed text-muted-strong">
          You can finish anyway. Flow will tell you the same thing on the pill the first time you hold the key.
        </p>
      </>
    );
  }

  return (
    <>
      <div className="ol-onb flex flex-col gap-3">
        <h1 className="text-title-lg font-semibold tracking-tight">Now do it once.</h1>
        <p className="max-w-[40rem] text-title-sm leading-relaxed text-muted-strong">
          {`Hold ${binding} and say anything. A pill appears next to your cursor, and it answers. Let go when you are done.`}
        </p>
      </div>

      <div className="ol-onb flex flex-wrap items-center gap-5 rounded-xl bg-card p-6 shadow-[var(--shadow-card)]">
        <OpenLiveOrb size={64} pulse={!heard} />
        <div className="flex min-w-[14rem] flex-1 flex-col gap-1.5">
          {heard ? (
            <>
              <span className="flex items-center gap-2 text-title-sm font-medium">
                <Check className="size-4 shrink-0 text-success-text" strokeWidth={2.6} aria-hidden /> That was it.
              </span>
              <p className="min-w-0 text-body leading-relaxed text-muted-strong">
                {latest ? `You said: “${sessionLine(latest)}”.` : "Flow heard you."} It is in Flow&rsquo;s history, and
                the key works exactly the same in every other app.
              </p>
            </>
          ) : (
            <>
              <span className="text-title-sm font-medium">Waiting for you</span>
              <p className="text-body leading-relaxed text-muted-strong">
                Try &ldquo;what can you do&rdquo;, or put your cursor in a text field and say &ldquo;write me a
                one-line summary of what Flow is&rdquo;.
              </p>
            </>
          )}
        </div>
        <span className="flex min-w-[4.5rem] shrink-0 items-center justify-center rounded-lg bg-surface-raised px-4 py-2.5 font-mono text-title-sm shadow-[inset_0_-2px_0_rgba(0,0,0,.08)]">
          {binding}
        </span>
      </div>

      <p className="ol-onb text-label leading-relaxed text-muted-strong">
        This window does not have to be open. Flow&rsquo;s key is armed for as long as OpenLive is running.
      </p>
    </>
  );
}

/** The first thing that would make a first turn fail, and where to go fix it. */
function whatIsMissing(perms: FlowPermissions | null, brainReady: boolean):
  { step: Step; title: string; detail: string; action: string } | null {
  if (perms && perms.microphone !== "granted") {
    return {
      step: "permissions",
      title: "The microphone has not been allowed",
      detail: "Flow cannot hear you until the system lets it open the microphone.",
      action: "Back to permissions",
    };
  }
  if (perms && !perms.accessibility) {
    return {
      step: "permissions",
      title: "Accessibility has not been granted",
      detail: "Flow can hear you, but the system will not let it hold a key for the whole machine, so the trigger cannot arm.",
      action: "Back to permissions",
    };
  }
  if (!brainReady) {
    return {
      step: "brain",
      title: "No brain is configured",
      detail: "Flow has nothing to think with: there is no provider key saved and no signed-in coding agent to talk to.",
      action: "Choose a brain",
    };
  }
  return null;
}

// ── shared pieces ───────────────────────────────────────────────────────────

const Card = ({ children, active, className }: { children: React.ReactNode; active?: boolean; className?: string }) => (
  <div className={cn("rounded-lg bg-card p-5 shadow-[var(--shadow-card)]",
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

function Toggle({ on, onFlip, label, note }: { on: boolean; onFlip: (v: boolean) => void; label: string; note: string }) {
  return (
    <div className="flex items-start gap-3">
      <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onFlip(!on)}
        className={cn("relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition", on ? "bg-accent" : "bg-foreground/15")}>
        <span className={cn("absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left]", on ? "left-[18px]" : "left-0.5")} />
      </button>
      <span className="min-w-0 text-body leading-snug text-foreground">
        {label}
        <span className="block text-label leading-relaxed text-muted-strong">{note}</span>
      </span>
    </div>
  );
}

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
          <span className={cn("grid size-9 shrink-0 place-items-center rounded-full", granted ? "bg-success/15" : "bg-arc-soft")}>
            {granted
              ? <Check className="size-4 text-success-text" strokeWidth={2.6} aria-hidden />
              : <span className="size-2.5 rounded-full bg-arc" aria-hidden />}
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
                className="flex items-center gap-2 rounded-full bg-accent px-4 py-2.5 text-callout font-medium text-accent-foreground transition hover:opacity-90">
                {action.icon && <ExternalLink className="size-4" aria-hidden />} {action.label}
              </button>
            )}
            {secondary && (
              <button type="button" onClick={secondary.run}
                className="rounded-full bg-surface-raised px-4 py-2.5 text-callout font-medium transition hover:bg-foreground/10">
                {secondary.label}
              </button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
