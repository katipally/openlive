"use client";

import { Mic, Video, X, Folder, FolderOpen } from "lucide-react";
import { useLiveStore, type DeviceOpt } from "@/lib/live/liveStore";
import { hasWebGPU, type ModelProgress } from "@/lib/live/models";
import type { AgentId } from "@/lib/live/liveClient";
import { TopBar } from "./TopBar";
import { CameraPreview, MicMeter, DownloadProgress, DeviceSelect } from "./LiveStage";
import { ModelQuickPick } from "./ModelQuickPick";
import { AgentQuickPick, agentLabel } from "./AgentControls";
import { AgentIcon } from "./AgentIcon";
import { setConversationFolder, setConversationModel, setConversationMode, recentFolders, cachedAgentMeta } from "@/lib/live/useLiveSession";
import { useUi } from "@/lib/uiStore";

const bridge = (): ((op: string, arg?: string) => Promise<string>) | undefined =>
  (typeof window !== "undefined" ? (window as unknown as { openlive?: { bridge?: (op: string, arg?: string) => Promise<string> } }).openlive?.bridge : undefined);
const basename = (p: string) => p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || p;

// Full-page pre-call lobby — shares the in-call skeleton (TopBar + main stage +
// right sidebar) so starting a call feels like a continuation, not a modal. Main =
// self-preview + the Start CTA; sidebar = who you're talking to + (for a coding
// agent) the required project folder, model and mode.
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
  // A coding agent needs a project folder before it can start.
  const needFolder = !!boundAgent && !boundCwd;

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
      <button onClick={onStart} disabled={needFolder}
        className="rounded-full bg-accent px-9 py-3 text-[15px] font-medium text-accent-foreground shadow-lg transition duration-150 enabled:hover:scale-[1.03] enabled:hover:opacity-90 enabled:active:scale-95 disabled:cursor-not-allowed disabled:opacity-40">
        Start
      </button>
      {needFolder && <p className="text-[11.5px] text-faint">Pick a project folder on the right to start.</p>}
    </div>
  );

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-background animate-live-in">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        {/* main stage — self-preview + the Start CTA */}
        <main className="relative min-w-0 flex-1 overflow-y-auto">
          <div className="m-auto flex min-h-full w-full max-w-md flex-col items-center justify-center gap-5 px-6 py-8 text-center">
            <div className="space-y-1">
              <h2 className="text-[22px] font-semibold tracking-tight">Talk with OpenLive</h2>
              <p className="max-w-sm text-[13px] text-muted-foreground">It listens as you speak, answers out loud, and can see through your camera. The voice runs privately on your device.</p>
              {cpu && (
                <p className="mx-auto max-w-xs rounded-lg border border-arc/30 bg-arc/10 px-2.5 py-1.5 text-[11.5px] text-arc">
                  Running voice on CPU — WebGPU isn&apos;t available, so responses will be slower.
                </p>
              )}
            </div>
            <CameraPreview camId={camId} onGranted={refreshDevices} />
            <MicMeter micId={micId} onGranted={refreshDevices} />
            {cta}
            {error && <p className="max-w-sm text-[12px] text-danger">{error}</p>}
          </div>
        </main>

        {/* setup sidebar — same position as the in-call transcript panel */}
        <aside className="flex w-[340px] shrink-0 flex-col border-l border-border bg-surface/40">
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
            <span className="text-[13px] font-semibold">Set up your call</span>
            <button onClick={onExit} title="Back to home" aria-label="Back to home"
              className="grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground"><X className="size-4" /></button>
          </div>
          <div className="openlive-scroll flex-1 space-y-6 overflow-y-auto p-4">
            <div className="space-y-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-faint">Talk to</p>
              <AgentQuickPick />
            </div>

            {boundAgent ? <AgentSetup agent={boundAgent} boundCwd={boundCwd} /> : <ModelQuickPick onOpenSettings={onOpenSettings} />}

            <div className="space-y-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-faint">Devices</p>
              <DeviceSelect icon={Mic} opts={mics} value={micId} onChange={onMic} />
              <DeviceSelect icon={Video} opts={cams} value={camId} onChange={onCam} />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

// Per-agent setup in the lobby sidebar: the REQUIRED project folder (with recents +
// Browse), and the agent's model + mode (from the last time it connected — the pick
// is applied when the call starts).
function AgentSetup({ agent, boundCwd }: { agent: AgentId; boundCwd: string }) {
  const chatId = useUi((s) => s.activeChatId);
  const openSettingsTab = useUi((s) => s.openSettingsTab);
  const liveMeta = useLiveStore((s) => s.agentMeta);
  const meta = liveMeta ?? cachedAgentMeta(agent);
  const recents = recentFolders().slice(0, 3);
  const b = bridge();
  const browse = async () => { if (!b) return; try { const p = await b("pick_folder"); if (p) setConversationFolder(chatId, p); } catch (e) { console.error("pick_folder:", e); } };
  const inputClass = "h-9 w-full rounded-lg border border-border bg-card px-3 font-mono text-[12px] text-foreground outline-none focus:border-border-heavy";
  const selectClass = "h-9 w-full rounded-lg border border-border bg-card px-3 text-[12.5px] text-foreground outline-none focus:border-border-heavy";

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 text-[13px] font-medium text-foreground">
        <AgentIcon id={agent} className="size-4" /> {agentLabel(agent)}
        <button onClick={() => openSettingsTab("agents")} className="ml-auto text-[11px] font-normal text-accent transition hover:underline">Sessions →</button>
      </div>

      <div className="space-y-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-faint">Project folder <span className="text-danger">*</span></p>
        {boundCwd ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
            <Folder className="size-4 shrink-0 text-accent" />
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground" title={boundCwd}>{boundCwd}</span>
            <button onClick={() => setConversationFolder(chatId, "")} className="shrink-0 text-[11px] text-faint transition hover:text-foreground">change</button>
          </div>
        ) : (
          <>
            <p className="text-[12px] leading-relaxed text-muted-foreground">Choose the folder {agentLabel(agent)} works in — this is the only place it can read and write.</p>
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

      {meta && meta.models.length > 0 && (
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-faint">Model</span>
          <select value={meta.currentModelId ?? ""} onChange={(e) => setConversationModel(e.target.value)} className={selectClass}>
            {meta.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
      )}

      {meta && meta.modes.length > 0 && (
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-faint">Mode</span>
          <select value={meta.currentModeId ?? ""} onChange={(e) => setConversationMode(e.target.value)} className={selectClass}>
            {meta.modes.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
      )}

      {(!meta || (!meta.models.length && !meta.modes.length)) && (
        <p className="text-[11.5px] leading-relaxed text-faint">{agentLabel(agent)}&apos;s real model &amp; mode will show here once it connects.</p>
      )}
    </div>
  );
}
