"use client";

import { useRef } from "react";
import { Mic, Video, X, Folder, FolderOpen, Settings2, PanelLeft } from "lucide-react";
import { useLiveStore, type DeviceOpt } from "@/lib/live/liveStore";
import { hasWebGPU, type ModelProgress } from "@/lib/live/models";
import type { AgentId } from "@/lib/live/liveClient";
import { CameraPreview, MicMeter, DownloadProgress, DeviceSelect } from "./LiveStage";
import { ModelQuickPick } from "./ModelQuickPick";
import { AgentQuickPick, agentLabel } from "./AgentControls";
import { setConversationFolder, setConversationModel, setConversationMode, setConversationOption, recentFolders, cachedAgentMeta } from "@/lib/live/useLiveSession";
import { useUi } from "@/lib/uiStore";
import { gsap, useGSAP, DUR, EASE, prefersReduced } from "@/lib/gsap";
import { cn } from "@/lib/cn";
import { isDesktop, isMacDesktop, basename, bridge } from "@/lib/platform";
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
      <button onClick={handleStart} disabled={needFolder}
        className="rounded-full bg-accent px-10 py-3 text-[15px] font-medium text-accent-foreground shadow-lg transition duration-150 enabled:hover:scale-[1.03] enabled:hover:opacity-90 enabled:active:scale-95 disabled:cursor-not-allowed disabled:opacity-40">
        Start
      </button>
      {needFolder && <p className="text-[11.5px] text-faint">Pick a project folder on the right to start.</p>}
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
          <div className="w-full max-w-[22rem] text-left">
            <WorkspaceField cwd={boundCwd} name={boundAgent ? agentLabel(boundAgent) : "OpenLive"} required={!!boundAgent} />
          </div>

          {cta}
          {error && <p className="max-w-sm text-[12px] text-danger">{error}</p>}
        </div>
      </main>

      {/* AI panel — a floating elevated card (same slot the in-call transcript uses,
          so start→call reads as continuous) */}
      <aside className="ol-lobby-aside m-3 ml-0 flex w-[360px] shrink-0 flex-col overflow-hidden rounded-2xl bg-surface-raised text-left shadow-[var(--shadow-pop)]">
        <header className={cn("flex h-14 shrink-0 items-center justify-between px-4", isDesktop && "[-webkit-app-region:drag]")}>
          <span className="text-[13px] font-semibold">Set up your call</span>
          <div className={cn("flex items-center gap-1", isDesktop && "[-webkit-app-region:no-drag]")}>
            <button onClick={onOpenSettings} title="Settings" aria-label="Settings"
              className="grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground"><Settings2 className="size-4" /></button>
            <button onClick={handleBack} title="Back to home" aria-label="Back to home"
              className="grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground"><X className="size-4" /></button>
          </div>
        </header>
        <div className="openlive-scroll flex-1 space-y-6 overflow-y-auto p-4">
          <div className="space-y-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-faint">Talk to</p>
            <AgentQuickPick />
          </div>

          {boundAgent ? <AgentSetup agent={boundAgent} /> : <ModelQuickPick onOpenSettings={onOpenSettings} />}
        </div>
      </aside>
    </div>
  );
}

// Reusable project-folder / workspace picker (recents + native Browse, or a path
// input on web). REQUIRED for a coding agent (its file-access scope); OPTIONAL for
// the built-in OpenLive assistant, so every "Talk to" target picks a workspace the
// same way.
function WorkspaceField({ cwd, name, required }: { cwd: string; name: string; required?: boolean }) {
  const chatId = useUi((s) => s.activeChatId);
  const recents = recentFolders().slice(0, 3);
  const b = bridge;
  const browse = async () => { if (!b) return; try { const p = await b("pick_folder"); if (p) setConversationFolder(chatId, p); } catch (e) { log.error("lobby", "pick_folder:", e); toast("Couldn\u2019t open the folder picker."); } };
  const inputClass = "h-9 w-full rounded-lg border border-border bg-card px-3 font-mono text-[12px] text-foreground outline-none focus:border-border-heavy";
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
        {required ? <>Project folder <span className="text-danger">*</span></> : <>Workspace <span className="rounded bg-surface px-1.5 py-0.5 text-[9.5px] font-normal lowercase tracking-normal text-muted-foreground">optional</span></>}
      </p>
      {cwd ? (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
          <Folder className="size-4 shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground" title={cwd}>{cwd}</span>
          <button onClick={() => setConversationFolder(chatId, "")} className="shrink-0 text-[11px] text-faint transition hover:text-foreground">change</button>
        </div>
      ) : (
        <>
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            {required ? `Choose the folder ${name} works in — the only place it can read and write.` : `Optionally ground ${name} in a project folder for this call.`}
          </p>
          {recents.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-[10.5px] uppercase tracking-wide text-faint">Recent</span>
              {recents.map((f) => (
                <button key={f} onClick={() => setConversationFolder(chatId, f)}
                  className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-left transition hover:border-border-heavy">
                  <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] text-foreground">{basename(f)}</span>
                    <span className="block truncate font-mono text-[10.5px] text-faint">{f}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
          {b ? (
            <button onClick={browse}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[12.5px] text-foreground transition hover:border-border-heavy">
              <FolderOpen className="size-4 text-accent" /> Choose a folder…
            </button>
          ) : (
            <input placeholder="/path/to/your/project" spellCheck={false} className={inputClass}
              onKeyDown={(e) => { if (e.key === "Enter") { const v = (e.target as HTMLInputElement).value.trim(); if (v) setConversationFolder(chatId, v); } }} />
          )}
        </>
      )}
    </div>
  );
}

// Per-agent setup in the lobby sidebar: the REQUIRED project folder, and the agent's
// model + mode. Models/modes come from the agent itself over ACP the moment it
// connects (cached per-agent between calls) — so the selectors are always shown, and
// sit disabled with a hint until that first connect populates them.
function AgentSetup({ agent }: { agent: AgentId }) {
  const liveMeta = useLiveStore((s) => s.agentMeta);
  const agentConnecting = useLiveStore((s) => s.agentConnecting);
  const meta = liveMeta ?? cachedAgentMeta(agent);
  const selectClass = "h-9 w-full rounded-lg border border-border bg-card px-3 text-[12.5px] text-foreground outline-none focus:border-border-heavy";
  const hasModels = !!meta && meta.models.length > 0;
  const hasModes = !!meta && meta.modes.length > 0;
  const loadingLabel = agentConnecting ? `Connecting to ${agentLabel(agent)}…` : "Loads when the call starts";

  return (
    <div className="space-y-5">
      {meta?.resumeAcrossRestart === false && (
        <p className="rounded-lg bg-foreground/[0.06] px-2.5 py-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
          Live only — {agentLabel(agent)} can&apos;t reopen this session in its own CLI after it closes (an agent limitation, not OpenLive).
        </p>
      )}

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-faint">Model</span>
        {hasModels ? (
          <select value={meta!.currentModelId ?? ""} onChange={(e) => setConversationModel(e.target.value)} className={selectClass}>
            {meta!.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        ) : (
          <select disabled className={cn(selectClass, "cursor-not-allowed text-muted-foreground opacity-60")}><option>{loadingLabel}</option></select>
        )}
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-faint">Mode</span>
        {hasModes ? (
          <select value={meta!.currentModeId ?? ""} onChange={(e) => setConversationMode(e.target.value)} className={selectClass}>
            {meta!.modes.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        ) : (
          <select disabled className={cn(selectClass, "cursor-not-allowed text-muted-foreground opacity-60")}><option>{loadingLabel}</option></select>
        )}
      </label>

      {/* Other ACP config options the agent exposes — reasoning/thought level, model
          config, … — rendered generically as their own dropdowns. */}
      {(meta?.options ?? []).filter((o) => o.values.length > 0).map((o) => (
        <label key={o.id} className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-faint">{optLabel(o.category, o.label)}</span>
          <select value={o.currentId ?? ""} onChange={(e) => setConversationOption(o.id, e.target.value)} className={selectClass}>
            {o.values.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
      ))}

      {!hasModels && !hasModes && (meta?.options ?? []).length === 0 && (
        <p className={cn("text-[11.5px] leading-relaxed", agentConnecting ? "text-muted-foreground" : "text-faint")}>
          {agentConnecting
            ? `Connecting to ${agentLabel(agent)} to load the models & modes it supports…`
            : `${agentLabel(agent)} reports the models & modes it supports over ACP — they populate the moment you pick a folder, and your choice is remembered for next time.`}
        </p>
      )}
    </div>
  );
}
