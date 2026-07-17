"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X, ChevronRight, ChevronsDownUp, Folder, Plus, Pencil, Trash2, AlertTriangle, Search } from "lucide-react";
import { api } from "@/lib/api";
import { useUi } from "@/lib/uiStore";
import { setConversationBind, setConversationFolder, setConversationResume } from "@/lib/live/useLiveSession";
import { AgentIcon } from "./live/AgentIcon";
import { OpenLiveOrb } from "./OpenLiveOrb";
import { usePersistedOpen, setDisclosure } from "@/lib/disclosure";
import { useHistoryOverrides } from "@/lib/historyOverrides";
import { gsap, useGSAP, DUR, EASE, prefersReduced } from "@/lib/gsap";
import { usePresence } from "@/lib/usePopIn";
import { useFocusTrap } from "@/lib/useFocusTrap";
import { Disclosure } from "@/components/Disclosure";
import { cn } from "@/lib/cn";
import { isDesktop, isMacDesktop, basename } from "@/lib/platform";
import type { AgentId } from "@/lib/live/liveClient";
import { AGENT_REGISTRY, agentLabel, isAgentId } from "@openlive/shared";
import type { HistoryChat, HistoryWorkspace } from "@openlive/shared";
import { SpotlightTour } from "@/components/SpotlightTour";
import { log } from "@/lib/log";
import { toast } from "@/lib/toast";

type ResumeFn = (c: HistoryChat, cwd: string) => void;
// A pending destructive action → the confirm modal. `run` performs it.
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

// Left History sidebar: workspace → chats (all agents' chats for a project
// together, each row wearing its agent's mark). New Chat pinned on top, search
// across titles + workspace names, rename/delete on hover, deletes gated by a
// confirm modal. Collapse state persists per workspace.
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
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  // "all" = every session, including ones the agents' own CLIs created;
  // "openlive" = only sessions started from OpenLive — hides external sessions
  // AND any workspace left with nothing (folders that were never connected here).
  const [filter, setFilter] = useState<"all" | "openlive">(() =>
    typeof window !== "undefined" && localStorage.getItem("ol-sessions-filter") === "openlive" ? "openlive" : "all");
  useEffect(() => { localStorage.setItem("ol-sessions-filter", filter); }, [filter]);
  const qc = useQueryClient();
  const { data: allWorkspaces = [], isLoading } = useQuery({ queryKey: ["history", "v2"], queryFn: api.history, enabled: open });
  // Apply the filter BEFORE anything renders or searches, so counts, search
  // results, and collapse-all all agree on what exists.
  const workspaces = useMemo(() => {
    if (filter === "all") return allWorkspaces;
    return allWorkspaces
      .map((ws) => ({ ...ws, chats: ws.chats.filter((c) => c.source !== "external") }))
      .filter((ws) => ws.chats.length > 0);
  }, [allWorkspaces, filter]);
  const collapseAll = () => { for (const ws of workspaces) setDisclosure(`hist:ws:${ws.cwd || "none"}`, false); };
  const overrides = useHistoryOverrides((st) => st.titles);

  useEffect(() => { if (open) setVisible(true); else { setQuery(""); setSearching(false); } }, [open]);

  const { contextSafe } = useGSAP(() => {
    if (!visible || prefersReduced()) return;
    gsap.fromTo(root.current, { xPercent: -100, autoAlpha: 0.6 }, { xPercent: 0, autoAlpha: 1, duration: DUR.slow, ease: EASE.out });
    gsap.fromTo(backdrop.current, { autoAlpha: 0 }, { autoAlpha: 1, duration: DUR.base, ease: EASE.soft });
  }, { scope: root, dependencies: [visible] });

  // Workspace groups cascade in once the list is on screen — keyed on the data
  // arriving (react-query), not just on open, so rows never pop in unanimated.
  useGSAP(() => {
    if (!visible || isLoading || prefersReduced()) return;
    gsap.fromTo(".ol-hist-node", { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: DUR.base, ease: EASE.out, stagger: 0.025, overwrite: "auto", clearProps: "all" });
  }, { scope: root, dependencies: [visible, isLoading] });

  const close = contextSafe(() => {
    const done = () => { setVisible(false); setOpen(false); };
    if (!root.current || prefersReduced()) { done(); return; }
    gsap.to(backdrop.current, { autoAlpha: 0, duration: DUR.fast, ease: EASE.soft });
    gsap.to(root.current, { xPercent: -100, autoAlpha: 0.6, duration: DUR.base, ease: EASE.out, onComplete: done });
  });

  const resume: ResumeFn = (c, cwd) => {
    // OpenLive chat → reopen it. External agent session → a fresh OpenLive
    // conversation that loadSession-s the agent's own prior thread. Either way, set
    // agent + workspace so the lobby shows the right setup and pre-connects.
    let chatId = c.id;
    if (c.source === "external") {
      useUi.getState().newConversation();
      chatId = useUi.getState().activeChatId;
      setConversationResume(chatId, c.resumeSessionId ?? c.id);
    } else {
      resumeChat(chatId);
    }
    setConversationBind(chatId, (c.agentId ?? null) as AgentId | null);
    if (cwd) setConversationFolder(chatId, cwd);
    setLiveOpen(true);
    close();
  };

  const newChat = () => { setOpen(false); useUi.getState().newConversation(); useUi.getState().setLiveOpen(true); };

  const requestDelete: RequestDelete = (r) => setPending(r);
  const runDelete = async () => {
    if (!pending) return;
    try { await pending.run(); } catch (e) { log.error("history", "delete:", e); toast("Couldn’t delete that conversation — try again."); }
    setPending(null);
    qc.invalidateQueries({ queryKey: ["history", "v2"] });
  };

  // Search: match chat titles (incl. local rename overrides) and workspace names.
  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!q) return null;
    const out: { chat: HistoryChat; cwd: string }[] = [];
    for (const ws of workspaces) {
      const wsHit = basename(ws.cwd).toLowerCase().includes(q) || ws.cwd.toLowerCase().includes(q);
      for (const chat of ws.chats) {
        const title = (overrides[chat.id] ?? chat.title).toLowerCase();
        if (wsHit || title.includes(q)) out.push({ chat, cwd: ws.cwd });
      }
    }
    return out.sort((a, b) => (a.chat.updatedAt < b.chat.updatedAt ? 1 : -1)).slice(0, 60);
  }, [q, workspaces, overrides]);

  if (!visible) return null;
  return (
    <>
      <div ref={backdrop} className="fixed inset-0 z-[54] bg-black/30" onClick={close} />
      <aside ref={root} className="fixed bottom-3 left-3 top-3 z-[55] flex w-[300px] flex-col overflow-hidden rounded-2xl bg-surface-raised text-left shadow-[var(--shadow-pop)]">
        <header className={cn("flex h-14 shrink-0 items-center justify-between pr-3", isMacDesktop ? "pl-[84px]" : "pl-4", isDesktop && "[-webkit-app-region:drag]")}>
          <span className="text-callout font-semibold">Sessions</span>
          <button onClick={close} aria-label="Close sessions" className={cn("grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground", isDesktop && "[-webkit-app-region:no-drag]")}><X className="size-4" /></button>
        </header>

        {/* New Chat + search share one row — tapping the magnifier expands the
            field over the button (width-animated), Escape/empty-blur collapses. */}
        <div className="flex shrink-0 items-center gap-2 p-2 pb-1" data-tour="history-actions">
          <button onClick={newChat} tabIndex={searching ? -1 : 0}
            className={cn("flex h-9 items-center justify-center gap-1.5 overflow-hidden whitespace-nowrap rounded-lg bg-accent text-label font-medium text-accent-foreground transition-[width,padding,opacity] duration-300 hover:opacity-90",
              searching ? "w-0 px-0 opacity-0" : "flex-1 px-3")}>
            <Plus className="size-4 shrink-0" /> New chat
          </button>
          <div className={cn("flex h-9 items-center gap-2 overflow-hidden rounded-lg bg-surface transition-[width,padding] duration-300", searching ? "flex-1 px-2.5" : "w-9 shrink-0 justify-center")}>
            {searching ? (
              <>
                <Search className="size-3.5 shrink-0 text-faint" />
                <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chats & folders…" spellCheck={false}
                  onKeyDown={(e) => { if (e.key === "Escape") { setQuery(""); setSearching(false); } }}
                  onBlur={() => { if (!query.trim()) setSearching(false); }}
                  className="h-8 min-w-0 flex-1 bg-transparent text-label text-foreground outline-none placeholder:text-faint" />
                <button onClick={() => { setQuery(""); setSearching(false); }} aria-label="Close search"
                  className="grid size-5 shrink-0 place-items-center rounded text-faint transition hover:text-foreground"><X className="size-3" /></button>
              </>
            ) : (
              <button onClick={() => setSearching(true)} aria-label="Search chats & folders" title="Search"
                className="grid size-9 place-items-center text-muted-foreground transition hover:text-foreground">
                <Search className="size-4" />
              </button>
            )}
          </div>
        </div>

        {/* Filter row: what's listed (All ↔ OpenLive-only) + collapse-all. The
            segmented control shows WHERE you are; tooltips explain each choice. */}
        <div className="flex shrink-0 items-center gap-2 px-2 pb-1.5">
          <div role="group" aria-label="Which sessions to show"
            className="flex h-7 flex-1 items-center gap-0.5 rounded-lg bg-surface p-0.5">
            <button onClick={() => setFilter("all")} aria-pressed={filter === "all"}
              title="Every session for these folders — including ones created in the agents' own CLIs"
              className={cn("h-6 flex-1 rounded-md text-caption font-medium transition-colors",
                filter === "all" ? "bg-elevated text-foreground shadow-[var(--shadow-xs)]" : "text-muted-foreground hover:text-foreground")}>
              All
            </button>
            <button onClick={() => setFilter("openlive")} aria-pressed={filter === "openlive"}
              title="Only sessions started from OpenLive — hides agent-CLI sessions and folders with none"
              className={cn("h-6 flex-1 rounded-md text-caption font-medium transition-colors",
                filter === "openlive" ? "bg-elevated text-foreground shadow-[var(--shadow-xs)]" : "text-muted-foreground hover:text-foreground")}>
              OpenLive
            </button>
          </div>
          <button onClick={collapseAll} title="Collapse all folders" aria-label="Collapse all folders"
            className="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground">
            <ChevronsDownUp className="size-3.5" />
          </button>
        </div>

        <div className="openlive-scroll min-h-0 flex-1 overflow-y-auto p-2 pt-1">
          {isLoading && <p className="px-2 py-4 text-label text-faint">Loading…</p>}
          {!isLoading && workspaces.length === 0 && (
            <div className="px-2 py-6 text-center">
              <p className="text-label text-muted-foreground">{filter === "openlive" ? "No OpenLive sessions yet." : "No sessions yet."}</p>
              <p className="mt-1 text-caption text-faint">{filter === "openlive" ? "Sessions you start here will appear — switch to All to see agent-CLI ones." : "Start one and it'll be filed here by project folder."}</p>
            </div>
          )}

          {results ? (
            <>
              {results.length === 0 && <p className="px-2 py-4 text-label text-faint">Nothing matches “{query.trim()}”.</p>}
              {results.map(({ chat, cwd }) => (
                <ChatRow key={chat.id} c={chat} cwd={cwd} showWorkspace activeChatId={activeChatId} resume={resume} requestDelete={requestDelete} />
              ))}
            </>
          ) : (
            workspaces.map((ws) => (
              <WorkspaceNode key={ws.cwd || "none"} ws={ws} activeChatId={activeChatId} resume={resume} requestDelete={requestDelete} />
            ))
          )}
        </div>
      </aside>

      <ConfirmModal pending={pending} onCancel={() => setPending(null)} onConfirm={runDelete} />

      <SpotlightTour id="history" steps={[
        { target: "history-actions", title: "All your conversations", body: "Chats are filed by project folder — every agent's work on a project in one place. Start fresh here, or tap the magnifier to search chats and folders." },
      ]} />
    </>
  );
}

// One workspace (project folder): all agents' chats for it, newest first.
// Open/closed state persists per folder across restarts.
function WorkspaceNode({ ws, activeChatId, resume, requestDelete }: { ws: HistoryWorkspace; activeChatId: string; resume: ResumeFn; requestDelete: RequestDelete }) {
  const [open, setOpen] = usePersistedOpen(`hist:ws:${ws.cwd || "none"}`);
  // ponytail: the history feed can list the same session id more than once — dedupe.
  const chats = [...new Map(ws.chats.map((s) => [s.id, s])).values()];
  const label = ws.cwd ? basename(ws.cwd) : "No folder";

  // opencode/hermes external sessions can't be deleted from here (live sqlite) —
  // they're skipped; the agent's own tooling manages them.
  const deletable = chats.filter((s) => s.source !== "external" || canDeleteExternal(s.agentId));
  const hasExternal = deletable.some((s) => s.source === "external");
  const deleteWorkspace = () => requestDelete({
    title: "Delete this workspace’s sessions?",
    body: `Removes ${deletable.length} conversation${deletable.length === 1 ? "" : "s"} under “${label}”.${hasExternal ? " External agent sessions are deleted from disk — that can’t be undone." : ""}${deletable.length < chats.length ? ` ${chats.length - deletable.length} agent-managed session${chats.length - deletable.length === 1 ? "" : "s"} stay (manage those in the agent).` : ""}`,
    run: async () => {
      for (const s of deletable) {
        if (s.source === "external") await api.deleteExternalSession(s.agentId ?? "", s.resumeSessionId ?? s.id);
        else await api.deleteChat(s.id);
      }
    },
  });

  return (
    <div className="group/ws ol-hist-node">
      <div role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen(!open)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(!open); } }}
        className="group/wsrow flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-label font-medium text-foreground transition hover:bg-foreground/[0.05]">
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition", open && "rotate-90")} />
        <Folder className="size-3.5 shrink-0 text-accent/80" />
        <span className="min-w-0 flex-1 truncate" title={ws.cwd || "No folder"}>{label}</span>
        <span className="text-micro font-normal text-faint">{chats.length}</span>
        <button onClick={(e) => { e.stopPropagation(); deleteWorkspace(); }} title="Delete this workspace’s sessions"
          className="grid size-6 shrink-0 place-items-center rounded text-faint opacity-0 transition hover:bg-danger/10 hover:text-danger group-hover/wsrow:opacity-100">
          <Trash2 className="size-3" />
        </button>
      </div>
      <Disclosure open={open}>
        <div className="mb-1 ml-[13px] flex flex-col gap-0.5 pl-2">
          {chats.map((c) => (
            <ChatRow key={c.id} c={c} cwd={ws.cwd} activeChatId={activeChatId} resume={resume} requestDelete={requestDelete} />
          ))}
        </div>
      </Disclosure>
    </div>
  );
}

// One chat row: the agent's mark + title (+ workspace subtitle in search results).
// Rename + delete surface on hover. Title = an OpenLive-side override (external
// sessions) or the real title (OpenLive sessions).
function ChatRow({ c, cwd, showWorkspace, activeChatId, resume, requestDelete }: { c: HistoryChat; cwd: string; showWorkspace?: boolean; activeChatId: string; resume: ResumeFn; requestDelete: RequestDelete }) {
  const qc = useQueryClient();
  const override = useHistoryOverrides((st) => st.titles[c.id]);
  const setOverride = useHistoryOverrides((st) => st.setTitle);
  const [editing, setEditing] = useState(false);
  const title = override ?? c.title;

  const commit = (val: string) => {
    setEditing(false);
    const t = val.trim();
    if (!t || t === title) return;
    if (c.source === "external") setOverride(c.id, t); // can't rewrite the agent's file — OpenLive-side title
    else api.renameChat(c.id, t).then(() => qc.invalidateQueries({ queryKey: ["history", "v2"] }));
  };

  const del = () => requestDelete({
    title: "Delete conversation?",
    body: c.source === "external"
      ? `Permanently deletes “${title}” from ${agentLabel(c.agentId)}’s own history on disk. This can’t be undone.`
      : `Permanently deletes “${title}” and its messages.`,
    run: async () => {
      if (c.source === "external") await api.deleteExternalSession(c.agentId ?? "", c.resumeSessionId ?? c.id);
      else await api.deleteChat(c.id);
    },
  });

  if (editing) {
    return (
      <input autoFocus defaultValue={title} spellCheck={false}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") commit((e.target as HTMLInputElement).value); if (e.key === "Escape") setEditing(false); }}
        className="my-0.5 w-full rounded-lg border border-border-heavy bg-surface px-2 py-1.5 text-label text-foreground outline-none focus:border-accent" />
    );
  }

  return (
    <div className={cn("group/s relative flex items-center rounded-lg transition hover:bg-foreground/[0.05]", c.id === activeChatId && "bg-foreground/[0.07]")}>
      <button onClick={() => resume(c, cwd)} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left" title={agentLabel(c.agentId)}>
        <span className="grid size-4 shrink-0 place-items-center">
          {c.agentId && isAgentId(c.agentId) ? <AgentIcon id={c.agentId} className="size-4" /> : <OpenLiveOrb size={15} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-label text-foreground">{title}</span>
          <span className="block truncate text-micro text-faint">
            {showWorkspace ? <>{cwd ? basename(cwd) : "No folder"} · </> : null}
            {relTime(c.updatedAt)}{c.source === "external" && " · external"}
          </span>
        </span>
      </button>
      <span className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-md bg-card/90 opacity-0 shadow-sm backdrop-blur-sm transition group-hover/s:opacity-100">
        <button onClick={() => setEditing(true)} title="Rename" className="grid size-6 place-items-center rounded text-muted-foreground transition hover:text-foreground"><Pencil className="size-3" /></button>
        {(c.source !== "external" || canDeleteExternal(c.agentId)) && (
          <button onClick={del} title="Delete" className="grid size-6 place-items-center rounded text-muted-foreground transition hover:text-danger"><Trash2 className="size-3" /></button>
        )}
      </span>
    </div>
  );
}

// Permission-gated confirm before any delete. Danger-styled; Escape / backdrop
// cancels. Real presence so it fades in/out instead of popping; z-modal so it sits
// above the History drawer (and Settings, if that's somehow up).
function ConfirmModal({ pending, onCancel, onConfirm }: { pending: PendingDelete | null; onCancel: () => void; onConfirm: () => void }) {
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const open = !!pending;
  // Retain the last pending through the exit fade (it's null once cancelled/run).
  const last = useRef(pending);
  if (pending) last.current = pending;
  const p = pending ?? last.current;
  const mounted = usePresence(rootRef, open);
  useEffect(() => { if (open) setBusy(false); }, [open]);
  useFocusTrap(rootRef, mounted, onCancel);
  if (!mounted || !p) return null;
  return (
    <div ref={rootRef} className="fixed inset-0 z-[var(--z-modal)] grid place-items-center p-6" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40" onClick={onCancel} />
      <div className="animate-modal-in relative w-full max-w-sm rounded-2xl bg-card p-5 shadow-[var(--shadow-pop)]">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-danger/10 text-danger"><AlertTriangle className="size-5" /></span>
          <div className="min-w-0">
            <h3 className="text-callout font-semibold text-foreground">{p.title}</h3>
            <p className="mt-1 text-label leading-relaxed text-muted-foreground">{p.body}</p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onCancel} disabled={busy}
            className="rounded-lg border border-border px-3.5 py-2 text-label font-medium text-muted-foreground transition hover:border-border-heavy hover:text-foreground disabled:opacity-50">Cancel</button>
          <button onClick={() => { setBusy(true); onConfirm(); }} disabled={busy}
            className="rounded-lg bg-danger px-3.5 py-2 text-label font-medium text-white transition hover:opacity-90 disabled:opacity-50">Delete</button>
        </div>
      </div>
    </div>
  );
}
