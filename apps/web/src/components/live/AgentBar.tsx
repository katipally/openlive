"use client";

import { useEffect, useRef, useState } from "react";
import { Folder, ChevronDown, Check, Cpu, SlidersHorizontal, FolderOpen } from "lucide-react";
import { useLiveStore } from "@/lib/live/liveStore";
import { setConversationFolder, setConversationModel, setConversationMode, recentFolders } from "@/lib/live/useLiveSession";
import { useUi } from "@/lib/uiStore";
import { cn } from "@/lib/cn";

const isDesktop = typeof navigator !== "undefined" && /Electron/i.test(navigator.userAgent);
const noDrag = isDesktop ? "[-webkit-app-region:no-drag]" : "";
const bridge = (): ((op: string, arg?: string) => Promise<string>) | undefined =>
  (typeof window !== "undefined" ? (window as unknown as { openlive?: { bridge?: (op: string, arg?: string) => Promise<string> } }).openlive?.bridge : undefined);
const basename = (p: string) => p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || p;

type Item = { id: string; label: string; sub?: string };

function PillMenu({ icon: Icon, label, title, items, current, onPick, footer }: {
  icon: typeof Folder; label: string; title: string; items: Item[]; current?: string | null;
  onPick: (id: string) => void; footer?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  return (
    <div ref={ref} className={cn("relative", noDrag)}>
      <button onClick={() => setOpen((o) => !o)} title={title}
        className="flex max-w-[180px] items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12.5px] text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground">
        <Icon className="size-3.5 shrink-0" /> <span className="truncate">{label}</span> <ChevronDown className={cn("size-3 shrink-0 transition", open && "rotate-180")} />
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-1.5 w-64 overflow-hidden rounded-xl border border-border bg-popover shadow-xl">
          <div className="px-3 pt-2 text-[10.5px] font-medium uppercase tracking-wide text-faint">{title}</div>
          <div className="openlive-scroll max-h-64 overflow-y-auto py-1">
            {items.map((it) => (
              <button key={it.id} onClick={() => { onPick(it.id); setOpen(false); }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition hover:bg-foreground/[0.06]">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] text-foreground">{it.label}</span>
                  {it.sub && <span className="block truncate font-mono text-[10.5px] text-faint">{it.sub}</span>}
                </span>
                {it.id === (current ?? "") && <Check className="size-3.5 shrink-0 text-success" />}
              </button>
            ))}
          </div>
          {footer && <div className="border-t border-border p-1.5" onClick={() => setOpen(false)}>{footer}</div>}
        </div>
      )}
    </div>
  );
}

/** Top-bar controls for the bound agent: project folder (with recents + Browse),
 *  and model / mode once the agent connects. Sits beside the agent selector so you
 *  see and change what you're working on at the top of the screen, mid-conversation. */
export function AgentBar() {
  const activeChatId = useUi((s) => s.activeChatId);
  const boundAgent = useLiveStore((s) => s.boundAgent);
  const boundCwd = useLiveStore((s) => s.boundCwd);
  const agentMeta = useLiveStore((s) => s.agentMeta);
  if (!boundAgent || !activeChatId) return null;

  const folderItems: Item[] = recentFolders().map((f) => ({ id: f, label: basename(f), sub: f }));
  const b = bridge();
  const browse = async () => { if (!b) return; const p = await b("pick_folder"); if (p) setConversationFolder(activeChatId, p); };

  const model = agentMeta?.models.find((m) => m.id === agentMeta.currentModelId);
  const mode = agentMeta?.modes.find((m) => m.id === agentMeta.currentModeId);

  return (
    <div className={cn("flex items-center gap-0.5", noDrag)}>
      <span className="text-border">·</span>
      <PillMenu icon={Folder} title="Project folder" label={boundCwd ? basename(boundCwd) : "Pick folder"}
        items={folderItems} current={boundCwd} onPick={(id) => setConversationFolder(activeChatId, id)}
        footer={b && (
          <button onClick={browse} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-foreground transition hover:bg-foreground/[0.06]">
            <FolderOpen className="size-4 text-accent" /> Browse…
          </button>
        )} />
      {agentMeta && agentMeta.models.length > 1 && (
        <PillMenu icon={Cpu} title="Model" label={model?.name ?? "Model"} items={agentMeta.models.map((m) => ({ id: m.id, label: m.name }))}
          current={agentMeta.currentModelId} onPick={setConversationModel} />
      )}
      {agentMeta && agentMeta.modes.length > 1 && (
        <PillMenu icon={SlidersHorizontal} title="Mode" label={mode?.name ?? "Mode"} items={agentMeta.modes.map((m) => ({ id: m.id, label: m.name }))}
          current={agentMeta.currentModeId} onPick={setConversationMode} />
      )}
    </div>
  );
}
