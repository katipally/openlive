"use client";

import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Mic, Video, X, Folder, FolderOpen, Settings2, PanelLeft, Wrench, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { useLiveStore, type DeviceOpt } from "@/lib/live/liveStore";
import { hasWebGPU, type ModelProgress } from "@/lib/live/models";
import type { AgentId } from "@/lib/live/liveClient";
import { CameraPreview, MicMeter, DownloadProgress, DeviceSelect } from "./LiveStage";
import { ModelQuickPick } from "./ModelQuickPick";
import { AgentQuickPick, agentLabel } from "./AgentControls";
import { Section, Field, Picker, AutoControl, ThinkNote, THINK_HINT } from "./SetupControls";
import { setConversationFolder, setConversationModel, setConversationMode, setConversationOption, recentFolders, cachedAgentMeta } from "@/lib/live/useLiveSession";
import { useUi } from "@/lib/uiStore";
import { gsap, useGSAP, DUR, EASE, prefersReduced } from "@/lib/gsap";
import { cn } from "@/lib/cn";
import { isDesktop, isMacDesktop, basename, bridge } from "@/lib/platform";
import { BUILTIN_PROVIDERS } from "@openlive/harness/registry";
import { SpotlightTour } from "@/components/SpotlightTour";
import { log } from "@/lib/log";
import { toast } from "@/lib/toast";

const NICE_CATEGORY: Record<string, string> = { thought_level: "Reasoning", model_config: "Model config" };
const optLabel = (category: string, label: string) => label || NICE_CATEGORY[category] || category || "Option";

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
  const cpu = typeof navigator !== "undefined" && !hasWebGPU();
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
  const { data: lobbySettings } = useQuery({ queryKey: ["settings"], queryFn: api.settings, enabled: !boundAgent });
  const { data: provRows = [] } = useQuery({ queryKey: ["providers"], queryFn: api.providers, enabled: !boundAgent });
  const providerId = boundAgent ? null : lobbySettings?.liveProviderId ?? provRows.find((p) => p.isDefault)?.kind ?? provRows[0]?.kind ?? BUILTIN_PROVIDERS[0]!.id;
  const provDef = providerId ? BUILTIN_PROVIDERS.find((p) => p.id === providerId) : null;
  const keyGap = !boundAgent && !!provDef && !provDef.keyless && provRows.length > 0 && !provRows.some((r) => r.kind === providerId && r.hasKey);
  // No audio input at all (nothing enumerated) — the call can't hear you. Warn, don't
  // block: a transiently-empty list right after mount shouldn't dead-lock Start.
  const micGap = mics.length === 0;
  const root = useRef<HTMLDivElement>(null);

  const { contextSafe } = useGSAP(() => {
    if (prefersReduced()) { gsap.fromTo(root.current, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.12 }); return; }
    gsap.timeline()
      .fromTo(root.current, { autoAlpha: 0 }, { autoAlpha: 1, duration: DUR.base, ease: EASE.soft })
      .fromTo(".ol-lobby-stage > *", { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0, stagger: 0.06, duration: DUR.slow, ease: EASE.snappy }, "-=0.06")
      .fromTo(".ol-lobby-aside", { autoAlpha: 0, x: 26 }, { autoAlpha: 1, x: 0, duration: DUR.slow, ease: EASE.out }, "<");
  }, { scope: root });

  // Back to home — exit is the entrance played in reverse (aside slides back out,
  // stage children fall back with a tail-first stagger, surface fades), then unmount.
  const handleBack = contextSafe(() => {
    if (!root.current || prefersReduced()) { onExit(); return; }
    gsap.timeline({ onComplete: onExit })
      .to(".ol-lobby-aside", { autoAlpha: 0, x: 26, duration: DUR.base, ease: EASE.inOut }, 0)
      .to(".ol-lobby-stage > *", { autoAlpha: 0, y: 12, stagger: { each: 0.04, from: "end" }, duration: DUR.base, ease: EASE.soft }, 0)
      .to(root.current, { autoAlpha: 0, duration: DUR.base, ease: EASE.soft }, 0.06);
  });

  // Into the call — a short "lift": the lobby rises and fades while InCall's
  // entrance rises to meet it, so start→call reads as one continuous move. The
  // session's start() runs on completion (~0.2 s — noise next to model warm-up).
  const handleStart = contextSafe(() => {
    if (!root.current || prefersReduced()) { onStart(); return; }
    gsap.timeline({ onComplete: onStart })
      .to(".ol-lobby-aside", { autoAlpha: 0, x: 14, duration: DUR.fast, ease: EASE.soft }, 0)
      .to(".ol-lobby-stage > *", { autoAlpha: 0, y: -10, stagger: 0.03, duration: DUR.fast, ease: EASE.soft }, 0)
      .to(root.current, { autoAlpha: 0, scale: 1.008, duration: DUR.base, ease: EASE.soft }, 0.04);
  });

  const cta = downloading ? (
    <div className="flex flex-col items-center gap-2">
      <p className="text-[12px] font-medium text-muted-foreground">Downloading on-device AI…</p>
      <DownloadProgress pct={downloadPct} loaded={downloadLoaded} total={downloadTotal} models={downloadModels} />
    </div>
  ) : !modelsDownloaded ? (
    <div className="flex flex-col items-center gap-2">
      <button onClick={onDownload} className="rounded-full bg-accent px-7 py-2.5 text-[14px] font-medium text-accent-foreground transition duration-150 hover:scale-[1.03] hover:opacity-90 active:scale-95">
        Download AI models
      </button>
      <p className="max-w-[17rem] text-[11px] text-faint">A one-time download of 3 small AI models (speech, voice, turn-taking) that run fully on your device — nothing is sent to a server.</p>
    </div>
  ) : (
    <div className="flex flex-col items-center gap-2">
      <button onClick={handleStart} disabled={needFolder || !!agentGap || folderGap || keyGap}
        className="rounded-full bg-accent px-10 py-3 text-[15px] font-medium text-accent-foreground shadow-lg transition duration-150 enabled:hover:scale-[1.03] enabled:hover:opacity-90 enabled:active:scale-95 disabled:cursor-not-allowed disabled:opacity-40">
        Start
      </button>
      {/* Pre-call verification: every gap that would break the call is surfaced HERE,
          before Start — not as a confusing failure after. */}
      {agentGap && (
        <button onClick={() => useUi.getState().openSettingsTab("agents")}
          className="flex items-center gap-1.5 rounded-lg border border-arc/40 bg-arc/10 px-3 py-1.5 text-[12px] font-medium text-arc transition hover:bg-arc/15">
          <Wrench className="size-3.5" />
          {agentGap === "install" ? `${agentLabel(boundAgent)} isn't installed — set it up` : `${agentLabel(boundAgent)} needs a sign-in — open Settings`}
        </button>
      )}
      {!agentGap && needFolder && <p className="text-[11.5px] text-faint">Pick a project folder above to start.</p>}
      {folderGap && (
        <p className="max-w-[20rem] rounded-lg border border-danger/30 bg-danger/10 px-3 py-1.5 text-[12px] text-danger">
          That folder doesn&apos;t exist anymore — pick a different one.
        </p>
      )}
      {keyGap && provDef && (
        <button onClick={() => useUi.getState().openSettingsTab("models")}
          className="flex items-center gap-1.5 rounded-lg border border-arc/40 bg-arc/10 px-3 py-1.5 text-[12px] font-medium text-arc transition hover:bg-arc/15">
          <Wrench className="size-3.5" /> No API key for {provDef.name} — add one in Settings
        </button>
      )}
      {micGap && <p className="text-[11.5px] text-arc">No microphone detected — connect one so the call can hear you.</p>}
    </div>
  );

  return (
    <div ref={root} className="fixed inset-0 z-40 flex bg-background">
      {/* main stage — self-preview, mic level, device pickers, Start */}
      <main className="relative min-w-0 flex-1 overflow-y-auto">
        {/* thin drag strip, clear of the macOS traffic lights (top-left) */}
        <div className={cn("app-drag absolute right-0 top-0 z-0 h-12", isMacDesktop ? "left-[84px]" : "left-4")} />
        <button onClick={() => useUi.getState().setHistoryOpen(true)} title="History" aria-label="History"
          className={cn("absolute top-2.5 z-10 grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground [-webkit-app-region:no-drag]", isMacDesktop ? "left-[84px]" : "left-3")}>
          <PanelLeft className="size-4" />
        </button>
        <div className="ol-lobby-stage m-auto flex min-h-full w-full max-w-md flex-col items-center justify-center gap-5 px-6 py-10 text-center">
          <div className="space-y-1">
            <h2 className="text-[22px] font-semibold tracking-tight">Talk with OpenLive</h2>
            <p className="max-w-sm text-[13px] text-muted-foreground">It listens as you speak, answers out loud, and can see through your camera. The voice runs privately on your device.</p>
            {cpu && (
              <p className="mx-auto mt-2 max-w-xs rounded-lg border border-arc/30 bg-arc/10 px-2.5 py-1.5 text-[11.5px] text-arc">
                Running voice on CPU — WebGPU isn&apos;t available, so responses will be slower.
              </p>
            )}
          </div>

          <CameraPreview camId={camId} onGranted={refreshDevices} />
          <MicMeter micId={micId} onGranted={refreshDevices} />

          {/* device pickers — moved under the preview so the right panel is all-AI */}
          <div className="flex w-full max-w-[22rem] items-stretch gap-2">
            <div className="min-w-0 flex-1"><DeviceSelect icon={Mic} opts={mics} value={micId} onChange={onMic} /></div>
            <div className="min-w-0 flex-1"><DeviceSelect icon={Video} opts={cams} value={camId} onChange={onCam} /></div>
          </div>

          {/* project folder — front and center (it gates Start for a coding agent) */}
          <div className="w-full max-w-[22rem] text-left" data-tour="folder">
            <WorkspaceField cwd={boundCwd} name={boundAgent ? agentLabel(boundAgent) : "OpenLive"} required={!!boundAgent} />
          </div>

          {cta}
          {error && <p className="max-w-sm text-[12px] text-danger">{error}</p>}
        </div>
      </main>

      {/* AI panel — a floating elevated card (same slot the in-call transcript uses,
          so start→call reads as continuous) */}
      <aside data-tour="setup-panel" className="ol-lobby-aside m-3 ml-0 flex w-[360px] shrink-0 flex-col overflow-hidden rounded-2xl bg-surface-raised text-left shadow-[var(--shadow-pop)]">
        <header className={cn("flex h-14 shrink-0 items-center justify-between px-4", isDesktop && "[-webkit-app-region:drag]")}>
          <span className="text-[14px] font-semibold tracking-tight">Set up your call</span>
          <div className={cn("flex items-center gap-1", isDesktop && "[-webkit-app-region:no-drag]")}>
            <button onClick={onOpenSettings} title="Settings" aria-label="Settings"
              className="grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground"><Settings2 className="size-4" /></button>
            <button onClick={handleBack} title="Back to home" aria-label="Back to home"
              className="grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground"><X className="size-4" /></button>
          </div>
        </header>
        <div className="openlive-scroll flex-1 space-y-6 overflow-y-auto p-4">
          <Section title="Talk to">
            <AgentQuickPick />
          </Section>

          {/* Everything below the rule is about the thing picked above. The rule is
              what makes "who" vs "how" two groups instead of one long list. */}
          <div className="h-px bg-border/60" />

          {boundAgent ? <AgentSetup agent={boundAgent} /> : <ModelQuickPick onOpenSettings={onOpenSettings} />}
        </div>
      </aside>

      <SpotlightTour id="lobby" steps={[
        { target: "folder", title: "Give it a project folder", body: "A coding agent works inside one folder — the only place it reads and writes, and where its session is saved so you can resume from the CLI too." },
        { target: "setup-panel", title: "The AI side of the call", body: "Who you talk to, plus the model and mode it runs with — reported live by the agent itself the moment it connects." },
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
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
          {required ? <>Project folder <span className="text-danger">*</span></> : <>Workspace <span className="rounded bg-surface px-1.5 py-0.5 text-[9.5px] font-normal lowercase tracking-normal text-muted-foreground">optional</span></>}
        </p>
        {b && (
          <button onClick={browse} aria-label={`Choose a folder for ${name}`}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] font-medium text-accent transition hover:bg-accent/10">
            <FolderOpen className="size-3.5" /> Browse…
          </button>
        )}
      </div>

      {cwd ? (
        <div className="flex items-center gap-2 rounded-lg bg-card px-3 py-2 shadow-[var(--shadow-card)]">
          <Folder className="size-4 shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground" title={cwd}>{cwd}</span>
          <button onClick={() => setConversationFolder(chatId, "")} className="shrink-0 text-[11px] text-faint transition hover:text-foreground">change</button>
        </div>
      ) : (
        <>
          {recents.length > 0 && (
            <div className="flex flex-col gap-1">
              {recents.map((f) => (
                <button key={f} onClick={() => setConversationFolder(chatId, f)} title={f}
                  className="flex items-center gap-2 rounded-lg bg-card px-2.5 py-2 text-left shadow-[var(--shadow-xs)] transition hover:shadow-[var(--shadow-card)]">
                  <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">{basename(f)}</span>
                  <span className="max-w-[45%] shrink-0 truncate font-mono text-[10px] text-faint">{f.replace(/^\/Users\/[^/]+/, "~")}</span>
                </button>
              ))}
            </div>
          )}
          {!b && (
            <input placeholder="/path/to/your/project" spellCheck={false}
              className="h-9 w-full rounded-lg bg-card px-3 font-mono text-[12px] text-foreground shadow-[var(--shadow-xs)] outline-none focus:shadow-[var(--shadow-card)]"
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
      <p className={cn("flex items-start gap-2 text-[11.5px] leading-relaxed", agentConnecting ? "text-muted-foreground" : "text-faint")}>
        {agentConnecting && <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" />}
        {agentConnecting
          ? `Connecting to ${agentLabel(agent)} to load the models & modes it supports…`
          : `${agentLabel(agent)} reports the models & modes it supports over ACP — they populate the moment you pick a folder, and your choice is remembered for next time.`}
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {meta?.resumeAcrossRestart === false && (
        <p className="rounded-lg bg-foreground/[0.06] px-2.5 py-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
          Live only — {agentLabel(agent)} can&apos;t reopen this session in its own CLI after it closes (an agent limitation, not OpenLive).
        </p>
      )}

      <Section title="How it runs">
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

        {/* Whatever else the agent exposes (reasoning/thought level, model config…).
            Reasoning gets the same "keep it low" steer as the built-in brain: this
            is a spoken call, and every extra thinking token is silence on the line. */}
        {opts.map((o) => {
          const thinking = o.category === "thought_level";
          return (
            <Field key={o.id} label={optLabel(o.category, o.label)} hint={thinking ? THINK_HINT : undefined}>
              <AutoControl ariaLabel={optLabel(o.category, o.label)} value={o.currentId}
                onChange={(v) => setConversationOption(o.id, v)}
                options={o.values.map((v) => ({ id: v.id, name: v.name }))} />
              {thinking && <ThinkNote />}
            </Field>
          );
        })}
      </Section>
    </div>
  );
}
