"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X, ChevronRight, Folder, Plus, Pencil, Trash2, AlertTriangle } from "lucide-react";
import { api } from "@/lib/api";
import { useUi } from "@/lib/uiStore";
import { setConversationBind, setConversationFolder, setConversationResume } from "@/lib/live/useLiveSession";
import { AgentIcon } from "./live/AgentIcon";
import { OpenLiveOrb } from "./OpenLiveOrb";
import { usePersistedOpen } from "@/lib/disclosure";
import { useHistoryOverrides } from "@/lib/historyOverrides";
import { gsap, useGSAP, DUR, EASE, prefersReduced } from "@/lib/gsap";
import { cn } from "@/lib/cn";
import { isDesktop, basename } from "@/lib/platform";
import type { AgentId } from "@/lib/live/liveClient";
import { AGENT_REGISTRY, agentLabel, isAgentId } from "@openlive/shared";
import type { HistoryAgent, HistorySession, HistoryWorkspace } from "@openlive/shared";
import { log } from "@/lib/log";
import { toast } from "@/lib/toast";

type ResumeFn = (s: HistorySession, agentId: string | null, cwd: string) => void;
// A pending destructive action → the confirm modal. `run` performs it; `danger`
// marks it irreversible (external on-disk delete).
interface PendingDelete { title: string; body: string; run: () => Promise<void> }
type RequestDelete = (r: PendingDelete) => void;

// External sessions we can delete are plain files/dirs; opencode/hermes keep theirs
// inside live sqlite databases we won't write into — no delete affordance for those.
const canDeleteExternal = (id: string | null) => !!id && isAgentId(id) && AGENT_REGISTRY[id].externalDeletable;
function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!t) return "";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Left History sidebar: agent → workspace → session, collapsible (state persisted).
// Sessions rename/delete on hover; deletes go through a gated confirm modal.
export function HistorySidebar() {
  const open = useUi((s) => s.historyOpen);
  const setOpen = useUi((s) => s.setHistoryOpen);
  const resumeChat = useUi((s) => s.resumeChat);
  const setLiveOpen = useUi((s) => s.setLiveOpen);
  const activeChatId = useUi((s) => s.activeChatId);
  const root = useRef<HTMLElement>(null);
  const backdrop = useRef<HTMLDivElement>(null); // sibling of root — animate via ref, not a scoped selector
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState<PendingDelete | null>(null);
  const qc = useQueryClient();
  const { data: agents = [], isLoading } = useQuery({ queryKey: ["history"], queryFn: api.history, enabled: open });

  useEffect(() => { if (open) setVisible(true); }, [open]);

  const { contextSafe } = useGSAP(() => {
    if (!visible || prefersReduced()) return;
    gsap.fromTo(root.current, { xPercent: -100, autoAlpha: 0.6 }, { xPercent: 0, autoAlpha: 1, duration: DUR.slow, ease: EASE.out });
    gsap.fromTo(backdrop.current, { autoAlpha: 0 }, { autoAlpha: 1, duration: DUR.base, ease: EASE.soft });
  }, { scope: root, dependencies: [visible] });

  const close = contextSafe(() => {
    const done = () => { setVisible(false); setOpen(false); };
    if (!root.current || prefersReduced()) { done(); return; }
    gsap.to(backdrop.current, { autoAlpha: 0, duration: DUR.fast, ease: EASE.soft });
    gsap.to(root.current, { xPercent: -100, autoAlpha: 0.6, duration: DUR.base, ease: EASE.out, onComplete: done });
  });

  const resume = (s: HistorySession, agentId: string | null, cwd: string) => {
    // OpenLive session → reopen it. External agent session → a fresh OpenLive
    // conversation that loadSession-s the agent's own prior thread. Either way, set
    // agent + workspace so the lobby shows the right setup and pre-connects.
    let chatId = s.id;
    if (s.source === "external") {
      useUi.getState().newConversation();
      chatId = useUi.getState().activeChatId;
      setConversationResume(chatId, s.resumeSessionId ?? s.id);
    } else {
      resumeChat(chatId);
    }
    setConversationBind(chatId, (agentId ?? null) as AgentId | null);
    if (cwd) setConversationFolder(chatId, cwd);
    setLiveOpen(true);
    close();
  };

  const requestDelete: RequestDelete = (r) => setPending(r);
  const runDelete = async () => {
    if (!pending) return;
    try { await pending.run(); } catch (e) { log.error("history", "delete:", e); toast("Couldn\u2019t delete that conversation — try again."); }
    setPending(null);
    qc.invalidateQueries({ queryKey: ["history"] });
  };

  if (!visible) return null;
  return (
    <>
      <div ref={backdrop} className="fixed inset-0 z-[54] bg-black/30" onClick={close} />
      <aside ref={root} className="fixed left-0 top-0 z-[55] flex h-full w-[300px] flex-col border-r border-border bg-background text-left shadow-2xl">
        <header className={cn("flex h-14 shrink-0 items-center justify-between border-b border-border pr-3", isDesktop ? "pl-[84px] [-webkit-app-region:drag]" : "pl-4")}>
          <span className="text-[14px] font-semibold">History</span>
          <button onClick={close} aria-label="Close history" className={cn("grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground", isDesktop && "[-webkit-app-region:no-drag]")}><X className="size-4" /></button>
        </header>

        <div className="openlive-scroll min-h-0 flex-1 overflow-y-auto p-2">
          {isLoading && <p className="px-2 py-4 text-[12.5px] text-faint">Loading…</p>}
          {!isLoading && agents.length === 0 && (
            <div className="px-2 py-6 text-center">
              <p className="text-[12.5px] text-muted-foreground">No conversations yet.</p>
              <p className="mt-1 text-[11.5px] text-faint">Start one and it&apos;ll be filed here by agent and workspace.</p>
            </div>
          )}

          {agents.map((agent) => (
            <AgentNode key={agent.agentId ?? "openlive"} agent={agent} activeChatId={activeChatId} resume={resume} requestDelete={requestDelete} />
          ))}
        </div>

        <button onClick={() => { setOpen(false); useUi.getState().newConversation(); useUi.getState().setLiveOpen(true); }}
          className="m-2 flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[12.5px] font-medium text-foreground transition hover:border-border-heavy">
          <Plus className="size-4 text-accent" /> New conversation
        </button>
      </aside>

      {pending && <ConfirmModal pending={pending} onCancel={() => setPending(null)} onConfirm={runDelete} />}
    </>
  );
}

// Agent node: collapsed by default, remembers its open/closed state across restarts.
function AgentNode({ agent, activeChatId, resume, requestDelete }: { agent: HistoryAgent; activeChatId: string; resume: ResumeFn; requestDelete: RequestDelete }) {
  const [open, setOpen] = usePersistedOpen(`hist:agent:${agent.agentId ?? "openlive"}`);
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="group/agent">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] font-semibold text-foreground transition hover:bg-foreground/[0.05] [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition group-open/agent:rotate-90" />
        {agent.agentId ? <AgentIcon id={agent.agentId as AgentId} className="size-4" /> : <OpenLiveOrb size={16} />}
        <span className="flex-1 truncate">{agent.label}</span>
      </summary>
      <div className="mb-1 ml-[15px] border-l border-border-heavy pl-2">
        {agent.workspaces.map((ws) => (
          <WorkspaceNode key={ws.cwd || "none"} agentId={agent.agentId} ws={ws} activeChatId={activeChatId} resume={resume} requestDelete={requestDelete} />
        ))}
      </div>
    </details>
  );
}

function WorkspaceNode({ agentId, ws, activeChatId, resume, requestDelete }: { agentId: string | null; ws: HistoryWorkspace; activeChatId: string; resume: ResumeFn; requestDelete: RequestDelete }) {
  const [open, setOpen] = usePersistedOpen(`hist:ws:${agentId ?? "openlive"}:${ws.cwd || "none"}`);
  // ponytail: the history feed can list the same session id more than once — dedupe.
  const sessions = [...new Map(ws.sessions.map((s) => [s.id, s])).values()];
  const label = ws.cwd ? basename(ws.cwd) : "No folder";

  // opencode/hermes external sessions can't be deleted from here (live sqlite) —
  // they're skipped; the agent's own tooling manages them.
  const deletable = sessions.filter((s) => s.source !== "external" || canDeleteExternal(agentId));
  const hasExternal = deletable.some((s) => s.source === "external");
  const deleteWorkspace = () => requestDelete({
    title: "Delete this workspace’s history?",
    body: `Removes ${deletable.length} conversation${deletable.length === 1 ? "" : "s"} under “${label}”.${hasExternal ? " External agent sessions are deleted from disk — that can’t be undone." : ""}${deletable.length < sessions.length ? ` ${sessions.length - deletable.length} of ${agentLabel(agentId)}’s own sessions stay (manage those in the agent).` : ""}`,
    run: async () => {
      for (const s of deletable) {
        if (s.source === "external") await api.deleteExternalSession(agentId ?? "", s.resumeSessionId ?? s.id);
        else await api.deleteChat(s.id);
      }
    },
  });

  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="group/ws">
      <summary className="group/wsrow flex cursor-pointer list-none items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-muted-foreground transition hover:bg-foreground/[0.04] [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3 shrink-0 text-muted-foreground transition group-open/ws:rotate-90" />
        <Folder className="size-3.5 shrink-0 text-faint" />
        <span className="min-w-0 flex-1 truncate" title={ws.cwd || "No folder"}>{label}</span>
        <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); deleteWorkspace(); }} title="Delete this workspace’s history"
          className="grid size-6 shrink-0 place-items-center rounded text-faint opacity-0 transition hover:bg-danger/10 hover:text-danger group-hover/wsrow:opacity-100">
          <Trash2 className="size-3" />
        </button>
      </summary>
      <div className="ml-[11px] flex flex-col gap-0.5 border-l border-border-heavy pl-2">
        {sessions.map((s) => (
          <SessionRow key={s.id} s={s} agentId={agentId} cwd={ws.cwd} activeChatId={activeChatId} resume={resume} requestDelete={requestDelete} />
        ))}
      </div>
    </details>
  );
}

// One session row. Rename + delete surface on hover. Title = an OpenLive-side
// override (external sessions) or the real title (OpenLive sessions).
function SessionRow({ s, agentId, cwd, activeChatId, resume, requestDelete }: { s: HistorySession; agentId: string | null; cwd: string; activeChatId: string; resume: ResumeFn; requestDelete: RequestDelete }) {
  const qc = useQueryClient();
  const override = useHistoryOverrides((st) => st.titles[s.id]);
  const setOverride = useHistoryOverrides((st) => st.setTitle);
  const [editing, setEditing] = useState(false);
  const title = override ?? s.title;

  const commit = (val: string) => {
    setEditing(false);
    const t = val.trim();
    if (!t || t === title) return;
    if (s.source === "external") setOverride(s.id, t); // can't rewrite the agent's file — OpenLive-side title
    else api.renameChat(s.id, t).then(() => qc.invalidateQueries({ queryKey: ["history"] }));
  };

  const del = () => requestDelete({
    title: "Delete conversation?",
    body: s.source === "external"
      ? `Permanently deletes “${title}” from ${agentLabel(agentId)}’s own history on disk. This can’t be undone.`
      : `Permanently deletes “${title}” and its messages.`,
    run: async () => {
      if (s.source === "external") await api.deleteExternalSession(agentId ?? "", s.resumeSessionId ?? s.id);
      else await api.deleteChat(s.id);
    },
  });

  if (editing) {
    return (
      <input autoFocus defaultValue={title} spellCheck={false}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") commit((e.target as HTMLInputElement).value); if (e.key === "Escape") setEditing(false); }}
        className="my-0.5 w-full rounded-lg border border-border-heavy bg-surface px-2 py-1.5 text-[12.5px] text-foreground outline-none focus:border-accent" />
    );
  }

  return (
    <div className={cn("group/s relative flex items-center rounded-lg transition hover:bg-foreground/[0.05]", s.id === activeChatId && "bg-foreground/[0.07]")}>
      <button onClick={() => resume(s, agentId, cwd)} className="flex min-w-0 flex-1 items-center px-2 py-1.5 text-left">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] text-foreground">{title}</span>
          <span className="block text-[10.5px] text-faint">{relTime(s.updatedAt)}{s.source === "external" && " · external"}</span>
        </span>
      </button>
      <span className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-md bg-card/90 opacity-0 shadow-sm backdrop-blur-sm transition group-hover/s:opacity-100">
        <button onClick={() => setEditing(true)} title="Rename" className="grid size-6 place-items-center rounded text-muted-foreground transition hover:text-foreground"><Pencil className="size-3" /></button>
        {(s.source !== "external" || canDeleteExternal(agentId)) && (
          <button onClick={del} title="Delete" className="grid size-6 place-items-center rounded text-muted-foreground transition hover:text-danger"><Trash2 className="size-3" /></button>
        )}
      </span>
    </div>
  );
}

// Permission-gated confirm before any delete. Danger-styled; Escape / backdrop cancels.
function ConfirmModal({ pending, onCancel, onConfirm }: { pending: PendingDelete; onCancel: () => void; onConfirm: () => void }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center p-6" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40" onClick={onCancel} />
      <div className="relative w-full max-w-sm rounded-2xl border border-border bg-card p-5 shadow-2xl">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-danger/10 text-danger"><AlertTriangle className="size-5" /></span>
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-foreground">{pending.title}</h3>
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{pending.body}</p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onCancel} disabled={busy}
            className="rounded-lg border border-border px-3.5 py-2 text-[12.5px] font-medium text-muted-foreground transition hover:border-border-heavy hover:text-foreground disabled:opacity-50">Cancel</button>
          <button onClick={() => { setBusy(true); onConfirm(); }} disabled={busy}
            className="rounded-lg bg-danger px-3.5 py-2 text-[12.5px] font-medium text-white transition hover:opacity-90 disabled:opacity-50">Delete</button>
        </div>
      </div>
    </div>
  );
}
