"use client";

import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Folder, ChevronDown, Cpu, SlidersHorizontal, FolderOpen, Gauge } from "lucide-react";
import { BUILTIN_PROVIDERS } from "@openlive/harness/registry";
import { allowedEfforts } from "@openlive/harness/types";
import { useLiveStore } from "@/lib/live/liveStore";
import { setConversationFolder, setConversationModel, setConversationMode, recentFolders, cachedAgentMeta } from "@/lib/live/useLiveSession";
import { useApiModeChoice } from "@/lib/live/useApiModeChoice";
import { useUi } from "@/lib/uiStore";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { menuItem, menuLabel, menuPanel, MenuCheck, useMenu, pill, Tooltip } from "@/components/ui";
import { isDesktop, basename, bridge } from "@/lib/platform";
import { effortName } from "./SetupControls";

const noDrag = isDesktop ? "[-webkit-app-region:no-drag]" : "";


type Item = { id: string; label: string; sub?: string };

function PillMenu({ icon: Icon, label, title, items, current, onPick, footer }: {
  icon: typeof Folder; label: string; title: string; items: Item[]; current?: string | null;
  onPick: (id: string) => void; footer?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { open, mounted, requestClose, toggle } = useMenu(ref, menuRef);
  return (
    <div ref={ref} className={cn("relative min-w-0", noDrag)}>
      <Tooltip label={title} className="flex max-w-full">
        <button onClick={toggle} aria-label={`${title}: ${label}`} aria-haspopup="menu" aria-expanded={open}
          className={cn(pill, "min-w-0")}>
          <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" /> <span className="min-w-0 truncate">{label}</span>
          <ChevronDown aria-hidden className={cn("size-3 shrink-0 text-muted-foreground transition", open && "rotate-180")} />
        </button>
      </Tooltip>
      {mounted && (
        <div ref={menuRef} role="menu" aria-label={title} className={cn("absolute right-0 z-overlay mt-1.5 w-64 max-w-[calc(100vw-2rem)] overflow-hidden", menuPanel)}>
          <div className={menuLabel}>{title}</div>
          <div className="openlive-scroll max-h-64 overflow-y-auto">
            {items.map((it) => (
              <button key={it.id} role="menuitemradio" aria-checked={it.id === (current ?? "")} onClick={() => { onPick(it.id); requestClose(); }}
                className={menuItem}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-label text-foreground">{it.label}</span>
                  {it.sub && <span className="block truncate font-mono text-micro text-faint">{it.sub}</span>}
                </span>
                {it.id === (current ?? "") && <MenuCheck />}
              </button>
            ))}
          </div>
          {footer && <div className="mt-1 border-t border-border pt-1.5" onClick={() => requestClose()}>{footer}</div>}
        </div>
      )}
    </div>
  );
}

/** The bound agent's project folder (with recents + Browse). Split out of AgentBar
 *  so the top bar can order it BEFORE the agent selector (Workspace → Agent → …). */
export function WorkspacePill() {
  const activeChatId = useUi((s) => s.activeChatId);
  const boundAgent = useLiveStore((s) => s.boundAgent);
  const boundCwd = useLiveStore((s) => s.boundCwd);
  if (!boundAgent || !activeChatId) return null;
  const folderItems: Item[] = recentFolders().map((f) => ({ id: f, label: basename(f), sub: f }));
  const b = bridge;
  const browse = async () => { if (!b) return; const p = await b("pick_folder"); if (p) setConversationFolder(activeChatId, p); };
  return (
    <PillMenu icon={Folder} title="Project folder" label={boundCwd ? basename(boundCwd) : "Pick folder"}
      items={folderItems} current={boundCwd} onPick={(id) => setConversationFolder(activeChatId, id)}
      footer={b && (
        <button role="menuitem" onClick={browse} className={cn(menuItem, "text-label text-foreground")}>
          <FolderOpen className="size-4 text-accent" /> Browse…
        </button>
      )} />
  );
}

/** Top-bar controls for the bound agent: model / mode once the agent connects.
 *  Sits beside the agent selector so you see and change what you're working on at
 *  the top of the screen, mid-conversation. (Workspace is `WorkspacePill`, above.) */
export function AgentBar() {
  const activeChatId = useUi((s) => s.activeChatId);
  const boundAgent = useLiveStore((s) => s.boundAgent);
  const liveMeta = useLiveStore((s) => s.agentMeta);
  if (!boundAgent || !activeChatId) return null;
  // Live meta when the agent has reported in; otherwise the per-agent cache (same
  // fallback the lobby uses) — so the model/mode chips don't blink out whenever a
  // reconnect/rebind clears the store before the agent re-reports.
  const agentMeta = liveMeta ?? cachedAgentMeta(boundAgent);
  if (!agentMeta) return null;

  const model = agentMeta.models.find((m) => m.id === agentMeta.currentModelId);
  const mode = agentMeta.modes.find((m) => m.id === agentMeta.currentModeId);

  return (
    <div className={cn("flex min-w-0 items-center gap-1.5", noDrag)}>
      {agentMeta.models.length > 1 && (
        <PillMenu icon={Cpu} title="Model" label={model?.name ?? "Model"} items={agentMeta.models.map((m) => ({ id: m.id, label: m.name }))}
          current={agentMeta.currentModelId} onPick={setConversationModel} />
      )}
      {agentMeta.modes.length > 1 && (
        <PillMenu icon={SlidersHorizontal} title="Mode" label={mode?.name ?? "Mode"} items={agentMeta.modes.map((m) => ({ id: m.id, label: m.name }))}
          current={agentMeta.currentModeId} onPick={setConversationMode} />
      )}
      {agentMeta.resumeAcrossRestart === false && (
        <Tooltip label="This session works live, but this agent can't reopen it in its own CLI after it closes (an agent limitation, not OpenLive)." className="ml-0.5 shrink-0">
          <span className="rounded-md bg-foreground/10 px-1.5 py-0.5 text-micro font-medium text-muted-foreground">live only</span>
        </Tooltip>
      )}
    </div>
  );
}

/** API mode's side of the bar: the model, and how hard it thinks when the model
 *  can. Both are the shared API-mode settings, read at the start of every turn,
 *  so a change applies from the next reply. API mode has no modes to offer: its
 *  tools run without asking, so there is no Mode pill to fake. */
export function ApiBar() {
  const boundAgent = useLiveStore((s) => s.boundAgent);
  const qc = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const { providerId, model: running } = useApiModeChoice();
  const { data: models = [] } = useQuery({ queryKey: ["models", providerId], queryFn: () => api.models(providerId), enabled: !!providerId && !boundAgent, retry: false });
  const save = useMutation({
    mutationFn: (b: Record<string, string>) => api.updateSettings(b),
    onSuccess: (s) => qc.setQueryData(["settings"], s),
    onError: () => toast("Couldn’t save that choice. Try again."),
  });
  if (boundAgent) return null;

  const picked = settings?.liveModel ?? "";
  const model = models.find((m) => m.id === (picked || running));
  const protocol = BUILTIN_PROVIDERS.find((p) => p.id === providerId)?.protocol;
  const efforts = ["auto", ...allowedEfforts(protocol, model?.reasoning ?? true)];
  const effort = efforts.find((e) => e === settings?.liveEffort) ?? "auto";
  const next = <p className="px-2.5 pb-0.5 pt-1.5 text-caption text-faint">Applies from the next reply</p>;

  return (
    <div className={cn("flex min-w-0 items-center gap-1.5", noDrag)}>
      <PillMenu icon={Cpu} title="Model" label={model?.display_name ?? (picked || running || "Recommended")}
        items={[{ id: "", label: "Recommended" }, ...models.map((m) => ({ id: m.id, label: m.display_name }))]}
        current={picked} onPick={(id) => save.mutate({ liveModel: id })} footer={next} />
      {efforts.length > 1 && (
        <PillMenu icon={Gauge} title="Effort" label={effortName(effort)} items={efforts.map((e) => ({ id: e, label: effortName(e) }))}
          current={effort} onPick={(id) => save.mutate({ liveEffort: id })} footer={next} />
      )}
    </div>
  );
}
