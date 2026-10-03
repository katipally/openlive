"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { animate, stagger } from "motion/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Mic, Video, X, Folder, FolderOpen, Settings2, PanelLeft, Wrench, Loader2 } from "lucide-react";
import { Button, Input, SidePanelHeader, sidePanel, Tooltip, notice } from "@/components/ui";
import { api } from "@/lib/api";
import { useLiveStore, type DeviceOpt } from "@/lib/live/liveStore";
import { hasWebGPU, voiceDownloadPlan, type ModelProgress } from "@/lib/live/models";
import { lobbyGap, offerStep, useLobbyBlocked } from "@/lib/live/lobbyGap";
import { aboutSize, listed, planModels, WEIGHTS_WHERE, type DownloadPlan } from "@/lib/live/weights";
import { brainIdOf } from "@/lib/telemetryIds";
import { loadPipelineConfig, isNativeVariant } from "@/lib/live/pipelineConfig";
import { missingEngines, engineName } from "@/lib/live/engineMenu";
import { useNativeEngines, variantStatus, downloadEngine, NoticeDownload } from "@/components/settings/PipelineSettings";
import type { AgentId } from "@/lib/live/liveClient";
import { CameraPreview, MicMeter, DownloadProgress, DeviceSelect } from "./LiveStage";
import { ModelQuickPick } from "./ModelQuickPick";
import { AgentQuickPick, agentLabel } from "./AgentControls";
import { Section, Field, Picker, AutoControl, ThinkNote, THINK_HINT, HowItRuns, SwitchField } from "./SetupControls";
import { agentSummary, optLabel, switchValues } from "@/lib/live/howItRuns";
import { setConversationFolder, setConversationModel, setConversationMode, setConversationOption, recentFolders, cachedAgentMeta } from "@/lib/live/useLiveSession";
import { useUi } from "@/lib/uiStore";
import { useApiModeChoice } from "@/lib/live/useApiModeChoice";
import { animateAll, EXIT, FADE, GENTLE, useMotionTokens } from "@/lib/motion";
import { cn } from "@/lib/cn";
import { isDesktop, isMacDesktop, basename, bridge, SETTINGS_KEYS } from "@/lib/platform";
import { BUILTIN_PROVIDERS } from "@openlive/harness/registry";
import { SpotlightTour } from "@/components/SpotlightTour";
import { log } from "@/lib/log";
import { toast } from "@/lib/toast";

// Full-page pre-call lobby. Left = a big self-preview with the mic meter, the mic
// & camera pickers, and the Start CTA directly under it. Right = the AI side of
// the call (who you're talking to + its model / mode / project folder). No top
// bar — the frameless window drags from a thin strip that clears the traffic
// lights, and Settings + Back live in the sidebar header.
export interface LobbyProps {
  mics: DeviceOpt[]; cams: DeviceOpt[]; micId?: string; camId?: string;
  onMic: (id: string) => void; onCam: (id: string) => void; error?: string;
  modelsDownloaded: boolean; downloading: boolean; downloadPct: number;
  downloadLoaded: number; downloadTotal: number; downloadModels: ModelProgress[];
  refreshDevices: () => Promise<void>; onDownload: () => void; onStart: () => void;
  onOpenSettings: () => void; onExit: () => void;
}

export function Lobby(props: LobbyProps) {
  const { mics, cams, micId, camId, onMic, onCam, error, modelsDownloaded, downloading,
    downloadPct, downloadLoaded, downloadTotal, downloadModels, refreshDevices, onDownload, onStart, onOpenSettings, onExit } = props;
  const boundAgent = useLiveStore((s) => s.boundAgent);
  const boundCwd = useLiveStore((s) => s.boundCwd);
  // Only the in-browser models slow down without WebGPU; native engines and a
  // cloned voice run on the agent's CPU either way.
  const voice = loadPipelineConfig();
  // A selected native engine the agent has not downloaded: the call runs on
  // its stand-in, so it joins the download offer rather than gating Start.
  const qc = useQueryClient();
  const { data: engines } = useNativeEngines();
  const missing = missingEngines(voice, engines);
  const downloadAll = () => {
    onDownload();
    for (const m of missing) { const e = variantStatus(engines, m.id); if (e && !e.downloading) void downloadEngine(e, qc); }
  };
  const cpu = typeof navigator !== "undefined" && !hasWebGPU()
    && (!isNativeVariant(voice.stt.variant) || voice.tts.family === "kokoro" || voice.tts.family === "supertonic");
  // A project folder is REQUIRED only for a coding agent (its file-access scope + where
  // its session is filed). The built-in OpenLive assistant needs no folder — a folderless
  // voice chat is valid (History files it under "No folder").
  const needFolder = !!boundAgent && !boundCwd;
  // Readiness of the picked coding agent: catch "not installed / signed out"
  // HERE, before Start fails with a spoken error — first-run users otherwise
  // never discover Settings → Agents.
  const { data: agentRows } = useQuery({ queryKey: ["agents"], queryFn: api.agents, enabled: !!boundAgent, refetchOnWindowFocus: true });
  const agentRow = boundAgent ? agentRows?.find((r) => r.id === boundAgent) : undefined;
  const agentGap = agentRow && !agentRow.installed ? "install" : agentRow?.credState === "login_required" ? "signin" : null;
  // The folder must actually EXIST — a deleted/renamed/typo'd path used to sail
  // through and fail confusingly mid-call. Re-checked on window focus so deleting
  // the folder while the lobby is open surfaces too.
  const { data: folderCheck } = useQuery({
    queryKey: ["workspace-ok", boundCwd],
    queryFn: () => fetch(`/api/workspace?path=${encodeURIComponent(boundCwd)}`).then((r) => r.json()) as Promise<{ ok: boolean }>,
    enabled: !!boundCwd, refetchOnWindowFocus: true,
  });
  const folderGap = !!boundCwd && folderCheck !== undefined && !folderCheck.ok;
  // Built-in brain: its provider needs an API key (unless keyless, e.g. local Ollama).
  const choice = useApiModeChoice();
  const provDef = boundAgent ? null : BUILTIN_PROVIDERS.find((p) => p.id === choice.providerId);
  const keyGap = !boundAgent && !choice.loading && !choice.usable;
  // No audio input at all (nothing enumerated) — the call can't hear you. Warn, don't
  // block: a transiently-empty list right after mount shouldn't dead-lock Start.
  const micGap = mics.length === 0;
  const leaveVia = useLobbyBlocked(
    lobbyGap({ modelsMissing: !modelsDownloaded, agentGap, needFolder, folderGap, keyGap, micGap }),
    boundAgent ? "acp" : "api", brainIdOf(boundAgent ?? choice.providerId),
  );
  const openSettings = () => { leaveVia("settings"); onOpenSettings(); };
  const root = useRef<HTMLDivElement>(null);

  const t = useMotionTokens();

  // Enter: the surface fades up, the stage rises in a stagger, the setup panel
  // slides in from the right.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const runs = t.reduce ? [animate(el, { opacity: [0, 1] }, t.fade)] : [
      animate(el, { opacity: [0, 1] }, FADE),
      animateAll(el, ".ol-lobby-stage > *", { opacity: [0, 1], y: [12, 0] }, { ...GENTLE, delay: stagger(0.06, { startDelay: 0.08 }) }),
      animateAll(el, ".ol-lobby-aside", { opacity: [0, 1], x: [26, 0] }, { ...GENTLE, delay: 0.08 }),
    ];
    return () => runs.forEach((r) => r?.stop());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the entrance plays on mount only
  }, []);

  // Back to home: the entrance in reverse (the panel slides back out, the stage
  // falls back tail-first, the surface fades), then unmount.
  const handleBack = async () => {
    leaveVia("back");
    const el = root.current;
    // Under glass the home comes back first, so this fade-out shows it.
    el?.removeAttribute("data-covering");
    if (el && !t.reduce) await Promise.all([
      animateAll(el, ".ol-lobby-aside", { opacity: 0, x: 26 }, EXIT),
      animateAll(el, ".ol-lobby-stage > *", { opacity: 0, y: 12 }, { ...EXIT, delay: stagger(0.03, { from: "last" }) }),
      animate(el, { opacity: 0 }, { ...EXIT, delay: 0.06 }),
    ]);
    onExit();
  };

  // Into the call: a short "lift". The lobby's contents rise and fade while
  // InCall's entrance rises to meet them, so start to call reads as one move.
  // The session's start() runs on completion (~0.2 s, noise next to model
  // warm-up). The page itself stays opaque: fading it showed the home through it.
  const handleStart = async () => {
    const el = root.current;
    if (el && !t.reduce) await Promise.all([
      animateAll(el, ".ol-lobby-aside", { opacity: 0, x: 14 }, EXIT),
      animateAll(el, ".ol-lobby-stage > *", { opacity: 0, y: -10 }, { ...EXIT, delay: stagger(0.03) }),
    ]);
    onStart();
  };

  // Start asks before it downloads: when weights the call needs are not in the
  // cache, it opens the offer (what, how big, where) instead of starting, and
  // the call starts once the download agreed to there is done.
  const [offer, setOffer] = useState<{ plan: DownloadPlan | null } | null>(null);
  const [accepted, setAccepted] = useState(false);
  const pressStart = async () => {
    setOffer({ plan: null });
    const plan = await voiceDownloadPlan();
    if (plan.missing.length) return setOffer({ plan });
    setOffer(null);
    void handleStart();
  };
  const accept = () => { setAccepted(true); downloadAll(); };
  const decline = () => { setOffer(null); setAccepted(false); };
  useEffect(() => {
    if (!accepted || downloading || !modelsDownloaded) return;
    setAccepted(false);
    setOffer(null);
    void handleStart();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleStart is rebuilt each render; the download finishing is the trigger
  }, [accepted, downloading, modelsDownloaded]);
  const online = typeof navigator === "undefined" || navigator.onLine;
  const step = offerStep({ open: !!offer, plan: offer?.plan ?? null, downloading, failed: accepted && !downloading && !modelsDownloaded && !!error, online });

  // Shown before the download too, so nobody fetches the models to only then learn
  // the brain cannot answer yet.
  const agentNotice = agentGap && (
    <button onClick={() => { leaveVia("settings"); useUi.getState().openSettingsTab("agents"); }} className={cn(notice("warning", true), "items-center py-1.5 font-medium")}>
      <Wrench aria-hidden />
      {agentGap === "install" ? `${agentLabel(boundAgent)} isn't installed. Set it up` : `${agentLabel(boundAgent)} needs a sign-in. Open Settings`}
    </button>
  );
  const keyNotice = keyGap && provDef && (
    <button onClick={() => { leaveVia("settings"); useUi.getState().openSettingsTab("models"); }} className={cn(notice("warning", true), "items-center py-1.5 font-medium")}>
      <Wrench aria-hidden /> No API key for {provDef.name}. Add one in Settings
    </button>
  );
  const engineRows = missing.map((m) => ({ name: engineName(m.id, engines), bytes: variantStatus(engines, m.id)?.sizeBytes ?? 0 }));
  const offerText = (plan: DownloadPlan) => {
    const names = [...planModels(plan), ...engineRows.map((e) => e.name)];
    const size = aboutSize(plan.bytes === null ? null : plan.bytes + engineRows.reduce((a, e) => a + e.bytes, 0));
    const what = listed(names);
    return `${what[0]!.toUpperCase()}${what.slice(1)} ${names.length > 1 ? "models" : "model"}, downloaded once${size ? `: ${size}` : ". The size could not be read just now"}.`;
  };
  const cta = step === "downloading" ? (
    <div className="flex flex-col items-center gap-2">
      <p className="text-label font-medium text-muted-foreground">Downloading on-device AI…</p>
      <DownloadProgress pct={downloadPct} loaded={downloadLoaded} total={downloadTotal} models={downloadModels} />
    </div>
  ) : step ? (
    <div role="dialog" aria-label="Download the voice models" className="flex w-full max-w-[24rem] flex-col gap-3 rounded-lg bg-secondary p-4 text-left shadow-rim">
      {step === "checking" ? (
        <p className="flex items-center gap-2 text-label text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden /> Checking what this call needs…</p>
      ) : (
        <>
          <p className="text-body font-medium text-foreground">
            {step === "ask" ? "Download the voice models first?" : step === "offline" ? "You're offline" : "The download stopped"}
          </p>
          <p className="break-words text-label text-muted-strong">
            {step === "ask" ? offerText(offer!.plan!)
              : step === "offline" ? "The voice models download once before the first call. Connect to the internet, then try again."
              : "Check the connection and try again. Nothing half-downloaded is kept."}
          </p>
          {step === "ask" && <p className="break-words text-caption text-faint">The call listens and speaks on this device. {WEIGHTS_WHERE}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={step === "ask" ? accept : step === "failed" ? accept : pressStart}>
              {step === "ask" ? "Download and start" : "Try again"}
            </Button>
            <Button variant="ghost" onClick={decline}>Cancel</Button>
          </div>
        </>
      )}
    </div>
  ) : (
    <div className="flex flex-col items-center gap-2">
      <Button variant="primary" size="lg" className="min-w-[12.5rem] max-w-full" onClick={pressStart} disabled={needFolder || !!agentGap || folderGap || keyGap}>
        Start
      </Button>
      {/* Pre-call verification: every gap that would break the call is surfaced HERE,
          before Start, and before any download: not as a confusing failure after. */}
      {agentNotice}
      {!agentGap && needFolder && <p className="text-caption text-faint">Pick a project folder above to start.</p>}
      {folderGap && (
        <p className={cn(notice("danger"), "max-w-[20rem] py-1.5")}>
          That folder doesn&apos;t exist anymore. Pick a different one.
        </p>
      )}
      {keyNotice}
      {micGap && <p className="text-caption text-arc-text">No microphone detected. Connect one so the call can hear you.</p>}
    </div>
  );
  const missingRows = missing.map((m) => (
    <div key={m.id} className="flex max-w-[22rem] flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-label text-arc-text">
      <span className="min-w-0 break-words">
        {engineName(m.id, engines)} isn&apos;t downloaded, so {m.standIn ? `calls use ${m.standIn} for now.` : "replies go unspoken in this language for now."}
      </span>
      <NoticeDownload id={m.id} />
    </div>
  ));

  return (
    <div ref={root} data-covering="stage" className="@container/lobby fixed inset-0 z-stage bg-background">
      {/* Side by side while both fit; narrower, the setup panel stacks under the
          stage and the whole page scrolls as one. */}
      <div className="flex h-full @max-3xl/lobby:flex-col @max-3xl/lobby:overflow-y-auto">
      {/* main stage — self-preview, mic level, device pickers, Start */}
      <main className="relative min-w-0 flex-1 overflow-y-auto @max-3xl/lobby:flex-none @max-3xl/lobby:overflow-visible">
        {/* thin drag strip, clear of the macOS traffic lights (top-left) */}
        <div className={cn("app-drag absolute right-0 top-0 z-0 h-12", isMacDesktop ? "left-traffic-lights" : "left-4")} />
        <div className="ol-lobby-stage relative m-auto flex min-h-full w-full max-w-[35rem] flex-col justify-center gap-5 px-6 pb-10 pt-14">
          <div className="flex min-w-0 items-center gap-2.5">
            <Tooltip label="Sessions"><Button variant="ghost" icon onClick={() => useUi.getState().setHistoryOpen(true)} aria-label="Sessions"><PanelLeft /></Button></Tooltip>
            <h1 className="min-w-0 break-words text-title-lg font-semibold tracking-tight">Talk with OpenLive</h1>
          </div>
          {cpu && (
            <p className={cn(notice(), "py-1.5 text-caption")}>
              Running voice on CPU. WebGPU isn&apos;t available, so responses will be slower.
            </p>
          )}

          <CameraPreview camId={camId} onGranted={refreshDevices} />

          <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5">
            <MicMeter micId={micId} onGranted={refreshDevices} />
            <div className="min-w-[9rem] flex-[1_1_11rem]"><DeviceSelect icon={Mic} opts={mics} value={micId} onChange={onMic} /></div>
            <div className="min-w-[9rem] flex-[1_1_11rem]"><DeviceSelect icon={Video} opts={cams} value={camId} onChange={onCam} /></div>
          </div>

          {/* project folder — front and center (it gates Start for a coding agent) */}
          <div className="text-left" data-tour="folder">
            <WorkspaceField cwd={boundCwd} name={agentLabel(boundAgent)} required={!!boundAgent} />
          </div>

          <div className="flex flex-col items-center gap-3 pt-3 text-center">
            {cta}
            {missingRows}
            {error && <p role="alert" className={cn(notice("danger"), "max-w-sm")}>{error}</p>}
          </div>
        </div>
      </main>

      {/* AI panel — the same slot the in-call transcript uses, so start→call reads as continuous */}
      <aside data-tour="setup-panel" aria-label="Set up your call"
        className={cn(sidePanel(), "ol-lobby-aside m-3 ml-0 w-[21.25rem] shrink-0 overflow-hidden @max-3xl/lobby:ml-3 @max-3xl/lobby:mt-0 @max-3xl/lobby:w-auto @max-3xl/lobby:overflow-visible")}>
        {/* Starts lower than the other panels: on Windows and Linux the window's
            own controls sit over this corner. */}
        <SidePanelHeader title="Set up your call" className={cn("pt-6", isDesktop && "[-webkit-app-region:drag]")}>
          <div className={cn("flex items-center gap-1", isDesktop && "[-webkit-app-region:no-drag]")}>
            <Tooltip label="Settings" keys={SETTINGS_KEYS}><Button variant="ghost" size="sm" icon onClick={openSettings} aria-label="Settings"><Settings2 /></Button></Tooltip>
            <Tooltip label="Back to home"><Button variant="ghost" size="sm" icon onClick={handleBack} aria-label="Back to home"><X /></Button></Tooltip>
          </div>
        </SidePanelHeader>
        <div className="openlive-scroll flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto px-5 pb-6 pt-1 @max-3xl/lobby:overflow-visible">
          <Section title="Talk to">
            <AgentQuickPick />
          </Section>
          {boundAgent ? <AgentSetup agent={boundAgent} /> : <ModelQuickPick onOpenSettings={openSettings} />}
        </div>
      </aside>
      </div>

      <SpotlightTour id="lobby" steps={[
        { target: "folder", title: "Give it a project folder", body: "The one place whoever answers reads and writes files. A coding agent also saves its session there, so you can resume it from its own CLI too." },
        { target: "setup-panel", title: "The AI side of the call", body: "Who you talk to, and how it runs: its model, effort or mode. A coding agent reports its own the moment it connects." },
      ]} />
    </div>
  );
}

// Compact project-folder picker: a label row with Browse on the right, recent
// folders as one-line chips beneath. REQUIRED for a coding agent (its file-access
// scope); optional for the built-in assistant.
function WorkspaceField({ cwd, name, required }: { cwd: string; name: string; required?: boolean }) {
  const chatId = useUi((s) => s.activeChatId);
  const recents = recentFolders().slice(0, 3).filter((f) => f !== cwd);
  const b = bridge;
  const browse = async () => { if (!b) return; try { const p = await b("pick_folder"); if (p) setConversationFolder(chatId, p); } catch (e) { log.error("lobby", "pick_folder:", e); toast("Couldn\u2019t open the folder picker."); } };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-h-control-sm flex-wrap items-center justify-between gap-2">
        <p className="text-label font-medium text-muted-strong">
          {required ? <>Project folder <span className="text-danger">*</span></> : <>Project folder <span className="font-normal text-faint">(optional)</span></>}
        </p>
        {b && !cwd && (
          <Button variant="ghost" size="sm" onClick={browse} aria-label={`Choose a folder for ${name}`}>
            <FolderOpen /> Browse&hellip;
          </Button>
        )}
      </div>

      {cwd ? (
        <div className="flex min-h-control-lg items-center gap-2.5 rounded-lg bg-secondary pl-3 pr-1.5 shadow-rim">
          <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Tooltip label={cwd} truncated className="min-w-0 flex-1"><span className="truncate font-mono text-label text-foreground">{cwd}</span></Tooltip>
          <Button variant="ghost" size="sm" onClick={() => setConversationFolder(chatId, "")}>Change</Button>
        </div>
      ) : (
        <>
          {recents.length > 0 && (
            <div className="flex flex-col">
              {recents.map((f) => (
                <Tooltip key={f} label={f} truncated className="flex">
                  <button type="button" onClick={() => setConversationFolder(chatId, f)}
                    className="flex min-h-control-md min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 text-left transition hover:bg-foreground/[0.06]">
                    <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-label text-foreground">{basename(f)}</span>
                    <span data-truncates className="max-w-[45%] shrink-0 truncate font-mono text-micro text-faint">{f.replace(/^\/Users\/[^/]+/, "~")}</span>
                  </button>
                </Tooltip>
              ))}
            </div>
          )}
          {!b && (
            <Input placeholder="/path/to/your/project" spellCheck={false} aria-label="Project folder path" className="w-full font-mono text-label"
              onKeyDown={(e) => { if (e.key === "Enter") { const v = (e.target as HTMLInputElement).value.trim(); if (v) setConversationFolder(chatId, v); } }} />
          )}
        </>
      )}
    </div>
  );
}

// Per-agent setup in the lobby sidebar: the agent's model, mode, and whatever else
// it exposes over ACP. Everything here is reported by the AGENT the moment it
// connects (cached per-agent between calls), so a field only appears once the agent
// says it exists — we never invent a control it can't honour. Short lists render as
// chips and long ones as a picker (see SetupControls), which is what keeps this from
// being the stack of identical dropdowns it used to be.
function AgentSetup({ agent }: { agent: AgentId }) {
  const liveMeta = useLiveStore((s) => s.agentMeta);
  const agentConnecting = useLiveStore((s) => s.agentConnecting);
  const meta = liveMeta ?? cachedAgentMeta(agent);
  const hasModels = !!meta && meta.models.length > 0;
  const hasModes = !!meta && meta.modes.length > 0;
  const opts = (meta?.options ?? []).filter((o) => o.values.length > 0);
  const nothingYet = !hasModels && !hasModes && opts.length === 0;

  // Until the agent connects there is nothing real to show. One honest line beats
  // a "How it runs" heading over three dropdowns stubbed with "Loads when the call
  // starts" — an empty section is a promise the panel can't keep yet.
  if (nothingYet) {
    return (
      <p className={cn("flex items-start gap-2 text-caption leading-relaxed", agentConnecting ? "text-muted-foreground" : "text-faint")}>
        {agentConnecting && <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" />}
        {agentConnecting
          ? `Connecting to ${agentLabel(agent)} to load the models & modes it supports…`
          : `${agentLabel(agent)} reports the models & modes it supports over ACP. They populate the moment you pick a folder, and your choice is remembered for next time.`}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {meta?.resumeAcrossRestart === false && (
        <p className="rounded-lg bg-foreground/[0.06] px-2.5 py-1.5 text-caption leading-relaxed text-muted-foreground">
          Live only: {agentLabel(agent)} can&apos;t reopen this session in its own CLI after it closes (an agent limitation, not OpenLive).
        </p>
      )}

      <HowItRuns summary={agentSummary(meta!)}>
        {hasModels && (
          <Field label="Model">
            <Picker ariaLabel="Model" value={meta!.currentModelId} onChange={setConversationModel}
              options={meta!.models.map((m) => ({ id: m.id, name: m.name }))} />
          </Field>
        )}

        {hasModes && (
          <Field label="Mode" hint="How much it asks first">
            <AutoControl ariaLabel="Mode" value={meta!.currentModeId} onChange={setConversationMode}
              options={meta!.modes.map((m) => ({ id: m.id, name: m.name }))} />
          </Field>
        )}

        {/* Whatever else the agent exposes (reasoning/thought level, fast mode,
            model config…). An on/off pair is a switch. Reasoning gets the same
            "keep it low" steer as the built-in brain: this is a spoken call, and
            every extra thinking token is silence on the line. */}
        {opts.map((o) => {
          const label = optLabel(o.category, o.label);
          const sw = switchValues(o.values);
          if (sw) {
            const on = o.currentId === sw.on;
            return <SwitchField key={o.id} label={label} on={on} onFlip={() => setConversationOption(o.id, on ? sw.off : sw.on)} />;
          }
          const thinking = o.category === "thought_level";
          return (
            <Field key={o.id} label={label} hint={thinking ? THINK_HINT : undefined}>
              <AutoControl ariaLabel={label} value={o.currentId}
                onChange={(v) => setConversationOption(o.id, v)}
                options={o.values.map((v) => ({ id: v.id, name: v.name }))} />
              {thinking && <ThinkNote />}
            </Field>
          );
        })}
        <p className="text-caption text-faint">Reported live by {agentLabel(agent)} the moment it connects.</p>
      </HowItRuns>
    </div>
  );
}
